use clap::Parser;
use skill_server::{SkillServerCli, dispatch};

fn main() {
    let cli = SkillServerCli::parse();
    match dispatch(&cli) {
        Ok(output) => output.print(),
        Err(error) => {
            eprintln!("error: {error}");
            std::process::exit(1);
        }
    }
}
