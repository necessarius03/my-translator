// Meeting summarisation.
//
// One command, three providers. Two of them (OpenAI and Alibaba DashScope)
// speak the same chat-completions shape, so they share a request builder and
// differ only in base URL; Gemini has its own request and response shape and
// gets its own pair of functions.
//
// The transcript never leaves this process except in the one request the user
// asked for, and the key is passed per call rather than cached in state — the
// frontend already owns settings, and a second copy here would be one more
// place a key could leak from.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::http_client;

/// Guardrail against sending a multi-hour transcript in one request: providers
/// reject oversized bodies with an unhelpful error, and the user pays for the
/// tokens either way. Roughly 100k characters is comfortably inside every
/// current provider's context window while still covering a long meeting.
const MAX_TRANSCRIPT_CHARS: usize = 100_000;

#[derive(Debug, Deserialize)]
pub struct SummarizeRequest {
    /// "openai" | "qwen" | "gemini"
    pub provider: String,
    pub api_key: String,
    pub model: String,
    /// Language the summary should be WRITTEN in (not the meeting's language).
    pub language: String,
    /// User-editable instructions; empty falls back to `default_instructions`.
    #[serde(default)]
    pub instructions: String,
    pub transcript: String,
}

#[derive(Debug, Serialize)]
pub struct SummarizeResult {
    pub text: String,
    pub provider: String,
    pub model: String,
    /// None when the provider does not report usage.
    pub total_tokens: Option<u64>,
    pub elapsed_ms: u64,
}

/// The built-in prompt. Written as a line list rather than one long literal so
/// the newlines the model actually receives are visible in the source.
///
/// Two instructions here earn their place: "only what is in the transcript"
/// (a summariser that invents an owner or a deadline is worse than none), and
/// the note about misrecognitions — the input is machine-written speech, and
/// without that line models tend to quote transcription errors verbatim.
fn default_instructions(language: &str) -> String {
    [
        format!("You are a meeting secretary. Summarise the transcript below, writing entirely in {language}."),
        format!("Use exactly these four sections, with the headings translated into {language}. Drop any section with nothing to report."),
        String::new(),
        "## Overview — 2 to 4 sentences.".to_string(),
        "## Decisions — bullets; only what was actually settled.".to_string(),
        "## Action items — one line each: owner, task, and the due date if one was stated.".to_string(),
        "## Open questions — raised but not concluded.".to_string(),
        String::new(),
        "Use only what is in the transcript. Do not infer, and never invent a name or a deadline."
            .to_string(),
        "The transcript is machine-written speech and contains misrecognitions. Read them in context rather than quoting a mistake verbatim."
            .to_string(),
    ]
    .join("\n")
}

/// Trim from the FRONT when a transcript is too long: the end of a meeting
/// carries the decisions, which is what a summary is for.
fn clamp_transcript(transcript: &str) -> (String, bool) {
    if transcript.chars().count() <= MAX_TRANSCRIPT_CHARS {
        return (transcript.to_string(), false);
    }
    let kept: String = transcript
        .chars()
        .skip(transcript.chars().count() - MAX_TRANSCRIPT_CHARS)
        .collect();
    (kept, true)
}

fn chat_base_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "openai" => Ok("https://api.openai.com/v1/chat/completions"),
        // DashScope's OpenAI-compatible endpoint (Singapore region, matching the
        // realtime engine's `dashscope-intl` host).
        "qwen" => Ok("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"),
        other => Err(format!("Unknown chat provider: {}", other)),
    }
}

async fn summarize_chat(
    req: &SummarizeRequest,
    transcript: &str,
) -> Result<(String, Option<u64>), String> {
    let url = chat_base_url(&req.provider)?;
    let instructions = if req.instructions.trim().is_empty() {
        default_instructions(&req.language)
    } else {
        req.instructions.clone()
    };

    let body = json!({
        "model": req.model,
        "messages": [
            {"role": "system", "content": instructions},
            {"role": "user", "content": transcript},
        ],
        "temperature": 0.2,
    });

    let resp = http_client::shared()
        .post(url)
        .bearer_auth(&req.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&body).map_err(|e| format!("Could not build the request: {}", e))?)
        .send()
        .await
        .map_err(|e| format!("Could not reach {}: {}", req.provider, e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Could not read the response: {}", e))?;

    if !status.is_success() {
        return Err(provider_error(status.as_u16(), &text));
    }

    let v: Value =
        serde_json::from_str(&text).map_err(|e| format!("The response was not JSON: {}", e))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "The response contained no summary text".to_string())?
        .to_string();
    let tokens = v["usage"]["total_tokens"].as_u64();
    Ok((content, tokens))
}

async fn summarize_gemini(
    req: &SummarizeRequest,
    transcript: &str,
) -> Result<(String, Option<u64>), String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        req.model
    );
    let instructions = if req.instructions.trim().is_empty() {
        default_instructions(&req.language)
    } else {
        req.instructions.clone()
    };

    let body = json!({
        "systemInstruction": {"parts": [{"text": instructions}]},
        "contents": [{"role": "user", "parts": [{"text": transcript}]}],
        "generationConfig": {"temperature": 0.2},
    });

    let resp = http_client::shared()
        .post(&url)
        // Gemini takes the key in a header, not as a bearer token or query
        // parameter — a query parameter would land the key in any request log.
        .header("x-goog-api-key", &req.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&body).map_err(|e| format!("Could not build the request: {}", e))?)
        .send()
        .await
        .map_err(|e| format!("Could not reach Gemini: {}", e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Could not read the response: {}", e))?;

    if !status.is_success() {
        return Err(provider_error(status.as_u16(), &text));
    }

    let v: Value =
        serde_json::from_str(&text).map_err(|e| format!("The response was not JSON: {}", e))?;
    let content = v["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "The response contained no summary text".to_string())?;
    let tokens = v["usageMetadata"]["totalTokenCount"].as_u64();
    Ok((content, tokens))
}

/// Turn a provider's HTTP failure into something the user can act on. The raw
/// body is appended (truncated) because provider messages are often the only
/// clue about a wrong model name.
fn provider_error(status: u16, body: &str) -> String {
    let hint = match status {
        401 | 403 => "Wrong API key, or it has no access to this model.",
        404 => "Model not found — check the model name in Settings.",
        429 => "Rate-limited, or the quota is spent. Try again later.",
        500..=599 => "The provider had an error. Try again later.",
        _ => "The request was rejected.",
    };
    let detail: String = body.chars().take(300).collect();
    format!("{} (HTTP {})\n{}", hint, status, detail)
}

#[tauri::command]
pub async fn summarize_text(req: SummarizeRequest) -> Result<SummarizeResult, String> {
    if req.api_key.trim().is_empty() {
        return Err("No API key for the summary provider. Add one in Settings.".into());
    }
    if req.transcript.trim().is_empty() {
        return Err("The transcript is empty — nothing to summarise.".into());
    }

    let (transcript, truncated) = clamp_transcript(&req.transcript);
    let started = std::time::Instant::now();

    let (mut text, tokens) = match req.provider.as_str() {
        "gemini" => summarize_gemini(&req, &transcript).await?,
        _ => summarize_chat(&req, &transcript).await?,
    };

    if truncated {
        // Say so in the artefact itself: a summary that silently covers only
        // part of a meeting is worse than no summary.
        text.push_str(
            "\n\n> ⚠️ The transcript was too long, so only its final part was summarised.",
        );
    }

    Ok(SummarizeResult {
        text,
        provider: req.provider,
        model: req.model,
        total_tokens: tokens,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
