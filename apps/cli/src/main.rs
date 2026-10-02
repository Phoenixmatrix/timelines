mod agent;
mod cli;
mod commands;
mod meta;
mod model;
mod output;
mod remote;
mod repo;
mod ssh;
mod tracker_cli;

use clap::{CommandFactory, FromArgMatches};
use cli::{BookmarkCommand, CliCommand, Command, FileCommand, OpCommand};
use commands::{Ctx, agents, ci, local, network, pkg, server, worktree};
use output::{Format, GmError, Render, emit, emit_error, exit};

/// Help text gets the git equivalent and examples from the manifest, and a
/// discovery banner when an agent is reading it.
fn build_command(agent: bool) -> clap::Command {
    fn decorate(cmd: clap::Command, prefix: &str, agent: bool) -> clap::Command {
        let names: Vec<String> = cmd
            .get_subcommands()
            .map(|s| s.get_name().to_string())
            .collect();
        let mut cmd = cmd;
        for name in names {
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix} {name}")
            };
            cmd = cmd.mut_subcommand(&name, |sub| {
                let mut sub = decorate(sub, &path, agent);
                if let Some(m) = meta::find(&path) {
                    let mut extra = String::new();
                    if !m.git.is_empty() {
                        extra.push_str(&format!("Git equivalent: {}\n", m.git));
                    }
                    if !m.examples.is_empty() {
                        extra.push_str("\nExamples:\n");
                        for e in m.examples {
                            extra.push_str(&format!("  {e}\n"));
                        }
                    }
                    if m.mutates {
                        extra.push_str("\nSupports --dry-run.\n");
                        if ["tracker ", "team ", "workspace ", "issue "].iter().any(|p| m.path.starts_with(p)) {
                            extra.push_str("Tracker changes are not reversed by `gm undo`; use an explicit versioned edit.\n");
                        } else if m.path.starts_with("worktree ") {
                            extra.push_str(
                                "Worktree creation/removal is not reversed by `gm undo`.\n",
                            );
                        } else {
                            extra.push_str("Undo with `gm undo`.\n");
                        }
                    }
                    extra.push_str(&format!("Output schema: gm schema {path}"));
                    sub = sub.after_help(extra);
                }
                if agent {
                    sub = sub.before_help(agent::DISCOVERY_BANNER);
                }
                sub
            });
        }
        cmd
    }
    let mut cmd = decorate(cli::Cli::command(), "", agent);
    cmd = cmd.after_help(
        "Start with `gm cli guide` for the workflow, `gm cli search \"<task>\"` to find a command.\nRevisions: @ (working copy), @- (parent), trunk, change id prefix (k-z), commit id prefix, bookmark.",
    );
    if agent {
        cmd = cmd.before_help(agent::DISCOVERY_BANNER);
    }
    cmd
}

fn quote(arg: &str) -> String {
    if arg.is_empty()
        || arg
            .chars()
            .any(|c| c.is_whitespace() || "\"'$`\\".contains(c))
    {
        format!("'{}'", arg.replace('\'', "'\\''"))
    } else {
        arg.to_string()
    }
}

/// The command line as the operation log shows it, without output flags.
fn recorded_command(argv: &[String]) -> String {
    let mut words = vec!["gm".to_string()];
    let mut skip = false;
    for arg in argv.iter().skip(1) {
        if skip {
            skip = false;
            continue;
        }
        if arg == "-o" || arg == "--output" {
            skip = true;
            continue;
        }
        if arg.starts_with("--output=")
            || (arg.starts_with("-o") && arg.len() > 2 && !arg.starts_with("--"))
        {
            continue;
        }
        words.push(quote(arg));
    }
    words.join(" ")
}

fn run(command: Command, ctx: &Ctx) -> Result<(), GmError> {
    let f = ctx.format;
    fn out<T: Render>(f: Format, r: Result<T, GmError>) -> Result<(), GmError> {
        emit(f, &r?);
        Ok(())
    }
    match command {
        Command::Tracker(a) => out(f, commands::tracker::tracker(ctx, &a)),
        Command::Team(a) => out(f, commands::tracker::team(ctx, &a)),
        Command::Workspace(a) => out(f, commands::tracker::workspace(ctx, &a)),
        Command::Issue(a) => out(f, commands::tracker::issue(ctx, &a)),
        Command::Request(a) => out(f, commands::tracker::request(ctx, &a)),
        Command::Status => out(f, local::status(ctx)),
        Command::Log(a) => out(f, local::log(ctx, &a)),
        Command::Show(a) => out(f, local::show(ctx, &a)),
        Command::Diff(a) => out(f, local::diff(ctx, &a)),
        Command::Describe(a) => out(f, local::describe(ctx, &a)),
        Command::New(a) => out(f, local::new(ctx, &a)),
        Command::Commit(a) => out(f, local::commit(ctx, &a)),
        Command::Squash(a) => out(f, local::squash(ctx, &a)),
        Command::Split(a) => out(f, local::split(ctx, &a)),
        Command::Edit(a) => out(f, local::edit(ctx, &a)),
        Command::Abandon(a) => out(f, local::abandon(ctx, &a)),
        Command::Restore(a) => out(f, local::restore(ctx, &a)),
        Command::Rebase(a) => out(f, local::rebase(ctx, &a)),
        Command::Backout(a) => out(f, local::backout(ctx, &a)),
        Command::Duplicate(a) => out(f, local::duplicate(ctx, &a)),
        Command::Undo => out(f, local::undo(ctx)),
        Command::Op(OpCommand::Log { limit }) => out(f, local::op_log(ctx, limit)),
        Command::Op(OpCommand::Restore { operation }) => out(f, local::op_restore(ctx, &operation)),
        Command::Bookmark(BookmarkCommand::List) => out(f, local::bookmark_list(ctx)),
        Command::Bookmark(BookmarkCommand::Set { name, revision }) => {
            out(f, local::bookmark_set(ctx, &name, &revision))
        }
        Command::Bookmark(BookmarkCommand::Delete { name, remote }) => {
            out(f, network::bookmark_delete(ctx, &name, remote))
        }
        Command::File(FileCommand::Show { path, revision }) => {
            out(f, local::file_show(ctx, &path, &revision))
        }
        Command::File(FileCommand::List { path, revision }) => {
            out(f, local::file_list(ctx, path.as_deref(), &revision))
        }
        Command::Worktree(c) => out(f, worktree::run(ctx, &c)),
        Command::Init => out(f, local::init(ctx)),
        Command::Clone(a) => out(f, network::clone(ctx, &a)),
        Command::Fetch => out(f, network::fetch(ctx)),
        Command::Sync => out(f, network::sync(ctx)),
        Command::Push(a) => out(f, network::push(ctx, &a)),
        Command::Auth(cli::AuthCommand::GitCredential { operation }) => {
            // Git reads this helper's stdout in its own key=value format.
            server::git_credential(&operation);
            Ok(())
        }
        Command::Auth(c) => out(f, server::auth(ctx, &c)),
        Command::Repo(c) => out(f, server::repo(ctx, &c)),
        Command::Semantic(c) => out(f, commands::semantic::run(ctx, &c)),
        Command::Runs(c) => out(f, ci::runs(ctx, &c)),
        Command::Runner(a) => out(f, ci::runner(ctx, &a)),
        Command::Secret(c) => out(f, ci::secret(ctx, &c)),
        Command::Agent(c) => out(f, agents::agent(ctx, &c)),
        Command::Pkg(c) => out(f, pkg::pkg(ctx, &c)),
        Command::Api(a) => out(f, server::api(ctx, &a.method, &a.path, a.data.as_deref())),
        Command::Cli(CliCommand::Search { query }) => {
            let query = query.join(" ");
            if query.trim().is_empty() {
                return Err(GmError::usage(
                    "Describe what you want to do: `gm cli search \"undo my last change\"`.",
                ));
            }
            out(f, Ok(meta::Hits(meta::search(&query))))
        }
        Command::Cli(CliCommand::Guide) => out(
            if f == Format::Json { Format::Text } else { f },
            Ok(meta::Guide { guide: meta::GUIDE }),
        ),
        Command::Cli(CliCommand::Commands) => out(
            f,
            Ok(model::Json(serde_json::json!({
                "commands": meta::manifest(),
                "global_options": meta::global_options(),
            }))),
        ),
        Command::Schema(a) => out(
            if f == Format::Text { Format::Pretty } else { f },
            meta::schema(&a.command),
        ),
    }
}

fn main() {
    let harness = agent::detect();
    let agent = harness.is_some();
    let argv: Vec<String> = std::env::args().collect();
    // Before parsing, so parse errors are formatted the same way.
    let early_format = argv
        .windows(2)
        .find(|w| w[0] == "-o" || w[0] == "--output")
        .and_then(|w| match w[1].as_str() {
            "json" => Some(Format::Json),
            "pretty" => Some(Format::Pretty),
            "text" => Some(Format::Text),
            _ => None,
        });
    let format = Format::detect(early_format, agent);

    let matches = match build_command(agent).try_get_matches_from(&argv) {
        Ok(m) => m,
        Err(e) => {
            use clap::error::ErrorKind::*;
            match e.kind() {
                DisplayHelp | DisplayVersion | DisplayHelpOnMissingArgumentOrSubcommand => {
                    let _ = e.print();
                    std::process::exit(0);
                }
                InvalidSubcommand => {
                    let word = argv
                        .iter()
                        .skip(1)
                        .find(|a| !a.starts_with('-'))
                        .cloned()
                        .unwrap_or_default();
                    let error = GmError::usage(format!("`gm {word}` is not a command."))
                        .hint(format!("Find the right one with `gm cli search \"{word}\"`, or read `gm cli guide`."));
                    emit_error(format, &error);
                    std::process::exit(exit::USAGE);
                }
                _ => {
                    let rendered = e.render().to_string();
                    let message = rendered
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim_start_matches("error: ")
                        .to_string();
                    let error = GmError::usage(message).hint(
                        rendered
                            .lines()
                            .skip(1)
                            .map(str::trim)
                            .filter(|l| !l.is_empty() && !l.starts_with("For more information"))
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                    let error = match error.hint.as_deref() {
                        Some("") => GmError {
                            hint: Some(
                                "Run the command with --help, or `gm schema <command>`.".into(),
                            ),
                            ..error
                        },
                        _ => error,
                    };
                    emit_error(format, &error);
                    std::process::exit(exit::USAGE);
                }
            }
        }
    };
    let parsed = cli::Cli::from_arg_matches(&matches).unwrap_or_else(|e| e.exit());
    let format = Format::detect(parsed.global.output, agent);
    let Some(command) = parsed.command else {
        let mut cmd = build_command(agent);
        let _ = cmd.print_help();
        std::process::exit(0);
    };
    let cwd = match &parsed.global.cwd {
        Some(dir) => dir.clone(),
        None => std::env::current_dir().expect("a current directory"),
    };
    let ctx = Ctx {
        format,
        dry_run: parsed.global.dry_run,
        cwd,
        argv: recorded_command(&argv),
    };
    if let Err(error) = run(command, &ctx) {
        emit_error(format, &error);
        std::process::exit(error.exit);
    }
}
