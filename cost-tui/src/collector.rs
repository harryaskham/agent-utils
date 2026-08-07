use std::collections::{BTreeMap, HashMap};
use std::process::Command;
use std::thread;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::model::{host_rank, AccountId, AccountUsage, Quota};

pub const DEFAULT_ACCOUNTS: [(&str, &str); 4] = [
    ("harryaskham", "github.com"),
    ("harryaskham_microsoft", "github.com"),
    ("harryaskham", "msft.ghe.com"),
    ("harryaskham", "microsoft.ghe.com"),
];

#[derive(Debug, Deserialize)]
struct AuthStatus {
    hosts: HashMap<String, Vec<AuthAccount>>,
}

#[derive(Debug, Deserialize)]
struct AuthAccount {
    login: String,
    #[serde(default)]
    state: String,
}

#[derive(Debug, Deserialize)]
struct CopilotUser {
    #[serde(default)]
    login: String,
    #[serde(default)]
    copilot_plan: String,
    #[serde(default)]
    access_type_sku: String,
    #[serde(default)]
    assigned_date: String,
    #[serde(default)]
    quota_snapshots: BTreeMap<String, Quota>,
}

pub fn parse_account(value: &str) -> Result<AccountId> {
    let (login, host) = value
        .rsplit_once('@')
        .ok_or_else(|| anyhow!("account must be LOGIN@HOST, got {value:?}"))?;
    if login.is_empty() || host.is_empty() {
        return Err(anyhow!("account must be LOGIN@HOST, got {value:?}"));
    }
    Ok(AccountId {
        login: login.into(),
        host: host.into(),
    })
}

#[must_use]
pub fn default_accounts() -> Vec<AccountId> {
    DEFAULT_ACCOUNTS
        .iter()
        .map(|(login, host)| AccountId {
            login: (*login).into(),
            host: (*host).into(),
        })
        .collect()
}

pub fn configured_accounts(values: &[String]) -> Result<Vec<AccountId>> {
    if values.is_empty() {
        discover_accounts().or_else(|_| Ok(default_accounts()))
    } else {
        values.iter().map(|value| parse_account(value)).collect()
    }
}

pub fn discover_accounts() -> Result<Vec<AccountId>> {
    let output = Command::new("gh")
        .args(["auth", "status", "--json", "hosts"])
        .output()
        .context("run `gh auth status --json hosts`")?;
    if !output.status.success() {
        return Err(anyhow!(
            "gh auth discovery failed: {}",
            compact_error(&output.stderr)
        ));
    }
    let status: AuthStatus =
        serde_json::from_slice(&output.stdout).context("parse gh auth status JSON")?;
    let mut accounts = Vec::new();
    for (host, entries) in status.hosts {
        for entry in entries {
            if entry.state.is_empty() || entry.state == "success" {
                accounts.push(AccountId {
                    login: entry.login,
                    host: host.clone(),
                });
            }
        }
    }
    accounts.sort_by(|left, right| {
        host_rank(&left.host)
            .cmp(&host_rank(&right.host))
            .then_with(|| left.host.cmp(&right.host))
            .then_with(|| left.login.cmp(&right.login))
    });
    accounts.dedup();
    if accounts.is_empty() {
        Err(anyhow!("gh has no authenticated accounts"))
    } else {
        Ok(accounts)
    }
}

#[must_use]
pub fn fetch_all(accounts: &[AccountId]) -> Vec<AccountUsage> {
    let handles: Vec<_> = accounts
        .iter()
        .cloned()
        .map(|account| thread::spawn(move || fetch_account(account)))
        .collect();
    handles
        .into_iter()
        .map(|handle| match handle.join() {
            Ok(usage) => usage,
            Err(_) => AccountUsage {
                error: Some("account refresh worker panicked".into()),
                ..AccountUsage::loading(AccountId {
                    login: "unknown".into(),
                    host: "unknown".into(),
                })
            },
        })
        .collect()
}

fn fetch_account(account: AccountId) -> AccountUsage {
    let refreshed_at = remote_cli::unix_now();
    match fetch_account_result(&account) {
        Ok(user) => AccountUsage {
            login: if user.login.is_empty() {
                account.login.clone()
            } else {
                user.login
            },
            account,
            plan: user.copilot_plan,
            sku: user.access_type_sku,
            assigned_date: user.assigned_date,
            quotas: user.quota_snapshots,
            refreshed_at,
            error: None,
        },
        Err(error) => AccountUsage {
            refreshed_at,
            error: Some(format!("{error:#}")),
            ..AccountUsage::loading(account)
        },
    }
}

fn fetch_account_result(account: &AccountId) -> Result<CopilotUser> {
    let token_output = Command::new("gh")
        .args([
            "auth",
            "token",
            "--hostname",
            &account.host,
            "--user",
            &account.login,
        ])
        .output()
        .with_context(|| format!("read gh token for {}", account.key()))?;
    if !token_output.status.success() {
        return Err(anyhow!(
            "gh auth token failed: {}",
            compact_error(&token_output.stderr)
        ));
    }
    let token = String::from_utf8(token_output.stdout)
        .context("gh returned a non-UTF-8 token")?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(anyhow!("gh returned an empty token"));
    }
    // The token is inherited only by this child. It never enters argv, logs,
    // cache, history, snapshots, or application state.
    let api_output = Command::new("gh")
        .args(["api", "--hostname", &account.host, "/copilot_internal/user"])
        .env("GH_TOKEN", &token)
        .env("GH_ENTERPRISE_TOKEN", &token)
        .output()
        .with_context(|| format!("query Copilot quota for {}", account.key()))?;
    drop(token);
    if !api_output.status.success() {
        return Err(anyhow!(
            "Copilot usage API failed: {}",
            compact_error(&api_output.stderr)
        ));
    }
    let user: CopilotUser =
        serde_json::from_slice(&api_output.stdout).context("parse Copilot usage response")?;
    if user.quota_snapshots.is_empty() {
        return Err(anyhow!("Copilot response contained no quota snapshots"));
    }
    Ok(user)
}

fn compact_error(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_account_from_the_right() {
        let account = parse_account("harryaskham_microsoft@github.com").unwrap();
        assert_eq!(account.login, "harryaskham_microsoft");
        assert_eq!(account.host, "github.com");
        assert!(parse_account("github.com").is_err());
    }

    #[test]
    fn parses_live_quota_shape() {
        let payload = r#"{
          "login":"harryaskham",
          "copilot_plan":"enterprise",
          "access_type_sku":"copilot_enterprise_seat_quota",
          "quota_snapshots":{"premium_interactions":{
            "credits_used":2061618,"entitlement":50000000,
            "percent_remaining":95.8,"quota_remaining":47938429.8,
            "remaining":47938429,"overage_permitted":true,
            "token_based_billing":true
          }}
        }"#;
        let user: CopilotUser = serde_json::from_str(payload).unwrap();
        let quota = &user.quota_snapshots["premium_interactions"];
        assert!((quota.credits_used - 2_061_618.0).abs() < f64::EPSILON);
        assert!((quota.remaining_value() - 47_938_429.8).abs() < f64::EPSILON);
    }
}
