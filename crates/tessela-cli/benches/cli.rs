//! `cargo bench -p tessela-cli` prints a table: each command at each bundle size, cold (no
//! parse cache yet) and warm, with the fastest of a few runs and how many pages the warm call
//! parsed. Release build, one call per row.

#[path = "../tests/support/mod.rs"]
mod support;

fn main() {
    let filter = std::env::args().skip(1).find(|a| !a.starts_with('-'));
    println!("each cell: cold / warm time, pages the warm call parsed");
    println!(
        "{:<18}{}",
        "command",
        support::SIZES
            .iter()
            .map(|n| format!("{:>34}", format!("{n} topics")))
            .collect::<String>()
    );
    let bundles: Vec<_> = support::SIZES
        .iter()
        .map(|&n| support::Bundle::generate(n))
        .collect();
    for case in support::COMMANDS {
        if filter.as_ref().is_some_and(|f| !case.name.contains(f)) {
            continue;
        }
        let cells: String = bundles
            .iter()
            .map(|b| {
                let m = support::measure(case, &b.root, 5);
                format!(
                    "{:>34}",
                    format!(
                        "{:.1} / {:.1} ms, {} parsed",
                        m.cold.ms, m.warm.ms, m.warm.parsed
                    )
                )
            })
            .collect();
        println!("{:<18}{cells}", case.name);
    }
    println!(
        "\npages: {}",
        bundles
            .iter()
            .map(|b| b.pages.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
}
