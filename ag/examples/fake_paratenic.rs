//! Visual-QA harness: run N fake Paratenic hosts with demo agents.
//! `cargo run --example fake_paratenic -- 3` prints one JSON line of URLs.
#[path = "../tests/support/fake_ahp.rs"]
mod fake_ahp;

fn main() {
    let count: usize = std::env::args()
        .nth(1)
        .and_then(|n| n.parse().ok())
        .unwrap_or(1);
    let urls: Vec<String> = (0..count)
        .map(|i| {
            let (address, _) = fake_ahp::fake_host_with(fake_ahp::Fake {
                demo: i == 0,
                ..Default::default()
            });
            format!("ws://{address}/ahp")
        })
        .collect();
    println!(
        "{}",
        serde_json::json!({"urls": urls, "token": fake_ahp::TOKEN})
    );
    loop {
        std::thread::park();
    }
}
