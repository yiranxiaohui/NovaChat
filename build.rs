use std::path::Path;
use std::process::Command;

fn main() {
    let web_dir = Path::new("web");
    if !web_dir.join("package.json").exists() {
        return;
    }

    println!("cargo:rerun-if-changed=web/package.json");
    println!("cargo:rerun-if-changed=web/bun.lock");
    println!("cargo:rerun-if-changed=web/index.html");
    println!("cargo:rerun-if-changed=web/vite.config.ts");
    println!("cargo:rerun-if-changed=web/tsconfig.json");
    println!("cargo:rerun-if-changed=web/tsconfig.app.json");
    println!("cargo:rerun-if-changed=web/components.json");
    rerun_tree("web/src");
    rerun_tree("web/public");

    if !web_dir.join("node_modules").exists() {
        run(web_dir, "bun", &["install"]);
    }
    run(web_dir, "bun", &["run", "build"]);
}

fn rerun_tree(dir: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            rerun_tree(&path.to_string_lossy());
        }
    }
}

fn run(cwd: &Path, program: &str, args: &[&str]) {
    let mut command = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(program).args(args);
        c
    } else {
        let mut c = Command::new(program);
        c.args(args);
        c
    };
    let status = command
        .current_dir(cwd)
        .status()
        .unwrap_or_else(|e| panic!("failed to spawn `{program} {}`: {e}", args.join(" ")));
    if !status.success() {
        panic!("`{program} {}` exited with {status}", args.join(" "));
    }
}
