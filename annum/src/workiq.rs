//! Persistent `WorkIQ` MCP client.
//!
//! Annum deliberately uses `WorkIQ`'s deterministic fetch/create/update/action
//! tools for its main surfaces. The generative `ask` tool is isolated behind
//! explicit `annum copilot ...` commands and is never part of background sync.

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use process_wrap::tokio::CommandWrap;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use rmcp::ServiceExt;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::transport::TokioChildProcess;
use serde_json::{Map, Value, json};

use crate::config::WorkIqConfig;

#[derive(Clone)]
pub struct WorkIqClient {
    tx: Sender<Request>,
    timeout: Duration,
}

struct Request {
    tool: String,
    arguments: Map<String, Value>,
    response: Sender<Result<Value, String>>,
}

impl WorkIqClient {
    pub fn start(config: &WorkIqConfig) -> Result<Self> {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let config = config.clone();
        let timeout = Duration::from_secs(config.timeout_secs.max(10));
        let initialization_timeout = timeout.max(Duration::from_secs(300));
        thread::Builder::new()
            .name("annum-workiq-mcp".into())
            .spawn(move || worker(config, rx, ready_tx))
            .context("spawn WorkIQ MCP worker")?;
        match ready_rx.recv_timeout(initialization_timeout.saturating_add(Duration::from_secs(5))) {
            Ok(Ok(())) => Ok(Self { tx, timeout }),
            Ok(Err(error)) => bail!("initialize WorkIQ MCP: {error}"),
            Err(error) => bail!("initialize WorkIQ MCP timed out: {error}"),
        }
    }

    pub fn call(&self, tool: &str, arguments: Value) -> Result<Value> {
        let arguments = arguments
            .as_object()
            .cloned()
            .context("WorkIQ tool arguments must be an object")?;
        let (response_tx, response_rx) = mpsc::channel();
        self.tx
            .send(Request {
                tool: tool.into(),
                arguments,
                response: response_tx,
            })
            .context("WorkIQ MCP worker stopped")?;
        response_rx
            .recv_timeout(self.timeout)
            .context("WorkIQ MCP request timed out")?
            .map_err(anyhow::Error::msg)
    }

    pub fn fetch(&self, entity_urls: Vec<String>) -> Result<Vec<Value>> {
        let value = self.call("fetch", json!({"entityUrls": entity_urls, "agentId": null}))?;
        let results = value
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| value.as_array().cloned())
            .context("WorkIQ fetch response has no results array")?;
        for result in &results {
            if result
                .get("statusCode")
                .and_then(Value::as_u64)
                .is_some_and(|status| !(200..300).contains(&status))
            {
                bail!("WorkIQ fetch failed: {result}");
            }
        }
        Ok(results)
    }

    pub fn ask(&self, question: &str, conversation_id: Option<&str>) -> Result<Value> {
        self.call(
            "ask",
            json!({
                "question": question,
                "fileUrls": null,
                "conversationId": conversation_id,
                "agentId": null
            }),
        )
    }

    pub fn retrieve(&self, query: Vec<String>) -> Result<Value> {
        self.call(
            "retrieve",
            json!({
                "query": query,
                "includeDeveloperCard": false,
                "agentId": null,
                "strategy": "grounding"
            }),
        )
    }

    pub fn create(&self, path: &str, body: Value) -> Result<Value> {
        self.call(
            "create_entity",
            json!({"entityUrl": path, "jsonBody": body, "agentId": null}),
        )
    }

    pub fn update(&self, path: &str, body: Value) -> Result<Value> {
        self.call(
            "update_entity",
            json!({"entityUrl": path, "jsonBody": body, "agentId": null}),
        )
    }

    pub fn action(&self, path: &str, body: Value) -> Result<Value> {
        self.call(
            "do_action",
            json!({"actionUrl": path, "jsonBody": body, "agentId": null}),
        )
    }
}

fn worker(config: WorkIqConfig, requests: Receiver<Request>, ready: Sender<Result<(), String>>) {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return;
        }
    };
    let mut command = tokio::process::Command::new(&config.command);
    command.args(&config.args);
    if let Some(account) = config.account.as_deref().filter(|value| !value.is_empty()) {
        command.arg("--account").arg(account);
    }
    let timeout = Duration::from_secs(config.timeout_secs.max(10));
    let initialization_timeout = timeout.max(Duration::from_secs(300));
    let mut command = CommandWrap::from(command);
    #[cfg(unix)]
    command.wrap(ProcessGroup::leader());
    let client = match runtime.block_on(async {
        let transport = TokioChildProcess::new(command).context("spawn WorkIQ MCP process")?;
        tokio::time::timeout(initialization_timeout, ().serve(transport))
            .await
            .context("WorkIQ MCP initialization timeout")?
            .context("WorkIQ MCP initialization")
    }) {
        Ok(client) => client,
        Err(error) => {
            // TokioChildProcess schedules process-group cleanup on drop. Give
            // that task one runtime turn before tearing the runtime down.
            runtime.block_on(async {
                tokio::time::sleep(Duration::from_millis(100)).await;
            });
            let _ = ready.send(Err(format!("{error:#}")));
            return;
        }
    };
    let _ = ready.send(Ok(()));

    while let Ok(request) = requests.recv() {
        let result = runtime.block_on(async {
            tokio::time::timeout(
                timeout,
                client.call_tool(
                    CallToolRequestParams::new(request.tool.clone())
                        .with_arguments(request.arguments),
                ),
            )
            .await
            .context("WorkIQ tool timeout")?
            .context("WorkIQ tool call")
            .and_then(extract_result)
        });
        let _ = request
            .response
            .send(result.map_err(|error| format!("{error:#}")));
    }
    let _ = runtime.block_on(client.cancel());
}

fn extract_result(result: CallToolResult) -> Result<Value> {
    if result.is_error.unwrap_or(false) {
        let message = result
            .content
            .iter()
            .filter_map(|content| content.raw.as_text())
            .map(|text| text.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let detail = if message.is_empty() {
            result.structured_content.as_ref().map_or_else(
                || "no error detail returned".into(),
                serde_json::Value::to_string,
            )
        } else {
            message
        };
        bail!("WorkIQ tool error: {detail}");
    }
    if let Some(value) = result.structured_content {
        return Ok(value);
    }
    let text = result
        .content
        .iter()
        .filter_map(|content| content.raw.as_text())
        .map(|text| text.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::Content;

    #[test]
    fn structured_results_are_preferred() {
        let result = CallToolResult::structured(json!({"results": [1]}));
        assert_eq!(extract_result(result).unwrap()["results"][0], 1);
    }

    #[test]
    fn textual_json_is_supported_for_older_servers() {
        let result = CallToolResult::success(vec![Content::text("{\"ok\":true}")]);
        assert_eq!(extract_result(result).unwrap()["ok"], true);
    }

    #[test]
    fn structured_tool_errors_are_not_rendered_blank() {
        let mut result = CallToolResult::error(Vec::new());
        result.structured_content = Some(json!({"code": "denied"}));
        let error = extract_result(result).unwrap_err().to_string();
        assert!(error.contains("denied"), "{error}");
    }

    #[test]
    fn persistent_client_completes_initialize_and_tool_call() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("server.py");
        std::fs::write(
            &script,
            r"import json,sys
for line in sys.stdin:
  message=json.loads(line)
  method=message.get('method')
  if method=='initialize':
    result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'fake-workiq','version':'1'}}
  elif method=='tools/call':
    result={'content':[],'structuredContent':{'results':[{'statusCode':200,'data':{'id':'me'}}]},'isError':False}
  elif 'id' not in message:
    continue
  else:
    result={}
  print(json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}),flush=True)
",
        )
        .unwrap();
        let config = WorkIqConfig {
            command: "python3".into(),
            args: vec![script.display().to_string()],
            account: None,
            timeout_secs: 10,
        };
        let client = WorkIqClient::start(&config).unwrap();
        let results = client.fetch(vec!["/me".into()]).unwrap();
        assert_eq!(results[0]["data"]["id"], "me");
    }
}
