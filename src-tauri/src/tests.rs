use crate::repository::*;
use std::{fs, path::Path, process::Command};

#[test]
fn startup_defaults_to_current_working_directory() {
    assert_eq!(
        crate::resolve_startup_path(None),
        Some(
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );
}

#[test]
fn startup_preserves_explicit_repository_path() {
    for path in [".", "../another-repository", r"C:\work\my repository"] {
        assert_eq!(
            crate::resolve_startup_path(Some(path.into())),
            Some(path.to_owned())
        );
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    repo: Repository,
}
fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "main"]);
        git(
            dir.path(),
            &["config", "user.email", "review@example.invalid"],
        );
        git(dir.path(), &["config", "user.name", "Reviewer"]);
        git(dir.path(), &["config", "commit.gpgsign", "false"]);
        git(dir.path(), &["config", "core.autocrlf", "false"]);
        git(dir.path(), &["config", "core.hooksPath", ".no-hooks"]);
        let repo = Repository::open(dir.path().to_str().unwrap()).unwrap();
        Self { dir, repo }
    }
    fn write(&self, path: &str, text: &str) {
        let path = self.dir.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn commit(&self, message: &str) -> String {
        git(self.dir.path(), &["add", "-A"]);
        git(self.dir.path(), &["commit", "-m", message]);
        git(self.dir.path(), &["rev-parse", "HEAD"])
    }
    fn document(&self) -> Document {
        let context = self.repo.snapshot(Mode::Diff, None).unwrap().context;
        Document {
            schema_version: 1,
            root: self.repo.root_string(),
            updated_at: "2026-10-30T01:00:00Z".into(),
            comments: vec![ReviewComment {
                id: "test-id".into(),
                path: "src/main.rs".into(),
                old_path: None,
                context,
                side: "old".into(),
                line: Some(2),
                end_line: Some(4),
                quote: None,
                text: "Keep <this> literal.\n```\nNested fence\n```".into(),
                status: "open".into(),
                created_at: "2026-10-30T01:00:00Z".into(),
                updated_at: "2026-10-30T01:00:00Z".into(),
            }],
        }
    }
}

#[test]
fn diff_combines_staged_unstaged_untracked_and_deleted() {
    let f = Fixture::new();
    f.write("staged.ts", "before\n");
    f.write("unstaged.py", "before\n");
    f.write("gone.md", "deleted\n");
    f.commit("initial");
    f.write("staged.ts", "staged\n");
    git(f.dir.path(), &["add", "staged.ts"]);
    f.write("staged.ts", "working version\n");
    f.write("unstaged.py", "after\n");
    f.write("new file 漢字.md", "new\n");
    fs::remove_file(f.dir.path().join("gone.md")).unwrap();
    let snapshot = f.repo.snapshot(Mode::Diff, None).unwrap();
    assert_eq!(snapshot.files.len(), 4);
    let staged = f
        .repo
        .content("staged.ts", None, &snapshot.context)
        .unwrap();
    assert_eq!(staged.old.as_deref(), Some("before\n"));
    assert_eq!(staged.new.as_deref(), Some("working version\n"));
    assert_eq!(
        snapshot
            .files
            .iter()
            .find(|f| f.path == "gone.md")
            .unwrap()
            .status,
        "D"
    );
    let gone = f.repo.content("gone.md", None, &snapshot.context).unwrap();
    assert!(gone.new.is_none());
    assert_eq!(gone.old.as_deref(), Some("deleted\n"));
    assert!(snapshot
        .files
        .iter()
        .any(|f| f.path == "new file 漢字.md" && f.status == "?"));
}

#[test]
fn diff_keeps_untracked_directories_collapsed_and_excludes_cancelled_changes() {
    let f = Fixture::new();
    f.write("tracked.txt", "original\n");
    f.commit("initial");
    f.write("tracked.txt", "staged\n");
    git(f.dir.path(), &["add", "tracked.txt"]);
    f.write("tracked.txt", "original\n");
    for index in 0..200 {
        f.write(&format!("untracked/deep/{index}.json"), "{}");
    }
    let snapshot = f.repo.snapshot(Mode::Diff, None).unwrap();
    assert_eq!(snapshot.files.len(), 1);
    assert_eq!(snapshot.files[0].path, "untracked");
    assert_eq!(snapshot.files[0].status, "?");
    assert!(snapshot.files[0].directory);
    let children = f.repo.folder_entries("untracked").unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].path, "untracked/deep");
    assert!(children[0].directory);
}

#[test]
fn unborn_diff_includes_staged_files_and_collapsed_untracked_directories() {
    let f = Fixture::new();
    f.write("staged.txt", "new");
    git(f.dir.path(), &["add", "staged.txt"]);
    f.write("nested/deep/file.txt", "new");
    let snapshot = f.repo.snapshot(Mode::Diff, None).unwrap();
    assert_eq!(snapshot.files.len(), 2);
    assert!(snapshot
        .files
        .iter()
        .any(|e| e.path == "staged.txt" && e.status == "A" && !e.directory));
    assert!(snapshot
        .files
        .iter()
        .any(|e| e.path == "nested" && e.status == "?" && e.directory));
}

#[test]
fn commit_uses_historical_content_and_initial_commit_has_empty_base() {
    let f = Fixture::new();
    f.write("sample.md", "initial\n");
    let initial = f.commit("initial");
    f.write("sample.md", "committed\n");
    let second = f.commit("second");
    f.write("sample.md", "not committed\n");
    let snapshot = f.repo.snapshot(Mode::Commit, Some(second.clone())).unwrap();
    assert_eq!(snapshot.context.base.as_deref(), Some(initial.as_str()));
    let file = f
        .repo
        .content("sample.md", None, &snapshot.context)
        .unwrap();
    assert_eq!(file.old.as_deref(), Some("initial\n"));
    assert_eq!(file.new.as_deref(), Some("committed\n"));
    let first = f.repo.snapshot(Mode::Commit, Some(initial)).unwrap();
    assert!(first.context.base.is_none());
    assert_eq!(first.files[0].status, "A");
    assert!(f
        .repo
        .content("sample.md", None, &first.context)
        .unwrap()
        .old
        .is_none());
    let commits = f.repo.commits().unwrap();
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].hash, second);
    assert_eq!(commits[0].subject, "second");
}

#[test]
fn merge_commit_compares_to_first_parent() {
    let f = Fixture::new();
    f.write("base", "base");
    f.commit("initial");
    git(f.dir.path(), &["checkout", "-b", "feature"]);
    f.write("feature", "feature");
    f.commit("feature");
    git(f.dir.path(), &["checkout", "main"]);
    f.write("main", "main");
    let parent = f.commit("main");
    git(
        f.dir.path(),
        &["merge", "--no-ff", "feature", "-m", "merge"],
    );
    let snapshot = f.repo.snapshot(Mode::Commit, None).unwrap();
    assert_eq!(snapshot.context.base, Some(parent));
    assert_eq!(snapshot.files.len(), 1);
    assert_eq!(snapshot.files[0].path, "feature");
}

#[test]
fn folder_honors_ignores_and_excludes_deleted_and_exports() {
    let f = Fixture::new();
    f.write(".gitignore", "ignored/\n");
    f.write("src/a.ts", "a");
    f.write("gone", "gone");
    f.commit("initial");
    f.write("ignored/secret", "no");
    f.write("new.txt", "yes");
    f.write(JSON_FILE, "generated");
    f.write(MARKDOWN_FILE, "generated");
    fs::remove_file(f.dir.path().join("gone")).unwrap();
    let snapshot = f.repo.snapshot(Mode::Folder, None).unwrap();
    let paths: Vec<_> = snapshot.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["src", ".gitignore", "new.txt"]);
    assert!(snapshot.files[0].directory);
    let nested = f.repo.folder_entries("src").unwrap();
    assert_eq!(nested.len(), 1);
    assert_eq!(nested[0].path, "src/a.ts");
    assert!(!nested[0].directory);
}

#[test]
fn folder_loading_is_shallow_and_preserves_tracked_ignored_files() {
    let f = Fixture::new();
    f.write("tracked/a.json", "{}");
    f.write("tracked/root.json", "{}");
    f.commit("initial");
    f.write(".gitignore", "tracked/\nignored/\n");
    f.write("ignored/a.json", "{}");
    f.write("deep/a/b/c/d/file.json", "{}");
    let entries = f.repo.folder_entries("").unwrap();
    assert!(entries.iter().any(|e| e.path == "deep" && e.directory));
    assert!(entries.iter().any(|e| e.path == "tracked" && e.directory));
    assert!(!entries
        .iter()
        .any(|e| e.path.contains('/') || e.path == "ignored"));
    assert_eq!(f.repo.folder_entries("tracked").unwrap().len(), 2);
    for path in ["../outside", ".git", "/absolute", "deep/../tracked"] {
        assert!(f.repo.folder_entries(path).is_err());
    }
}

#[test]
fn filename_search_supports_nested_globs_ignores_deleted_files_and_caps_results() {
    let f = Fixture::new();
    f.write(".gitignore", "ignored/\n");
    f.write("gone.json", "{}");
    f.commit("initial");
    fs::remove_file(f.dir.path().join("gone.json")).unwrap();
    f.write("config/nested/app.JSON", "{}");
    f.write("config/app1.json", "{}");
    f.write("config/other.txt", "text");
    f.write("ignored/private.json", "{}");
    f.write(JSON_FILE, "export");
    let found = f.repo.search_files("*.json").unwrap();
    assert_eq!(found.files.len(), 2);
    assert!(!found.truncated);
    assert_eq!(f.repo.search_files("app?.json").unwrap().files.len(), 1);
    assert_eq!(
        f.repo.search_files("config/*APP.json").unwrap().files.len(),
        1
    );
    assert_eq!(f.repo.search_files("nested").unwrap().files.len(), 1);
    assert!(f.repo.search_files("[abc]*.json").unwrap().files.is_empty());
    for index in 0..510 {
        f.write(&format!("many/{index}.json"), "{}");
    }
    let found = f.repo.search_files("*.json").unwrap();
    assert_eq!(found.files.len(), 500);
    assert!(found.truncated);
}

#[test]
fn supports_unborn_repository_and_subfolder_selection() {
    let f = Fixture::new();
    f.write("nested/file.txt", "hello");
    let repo = Repository::open(f.dir.path().join("nested").to_str().unwrap()).unwrap();
    assert_eq!(repo.root, f.repo.root);
    let snapshot = repo.snapshot(Mode::Diff, None).unwrap();
    assert!(snapshot.context.base.is_none());
    assert_eq!(snapshot.files.len(), 1);
    assert!(repo.commits().unwrap().is_empty());
    assert!(repo.snapshot(Mode::Commit, None).is_err());
}

#[test]
fn rename_preserves_old_path_and_content() {
    let f = Fixture::new();
    f.write("old name.ts", "const a = 1;\nconst b = 2;\n");
    f.commit("initial");
    git(f.dir.path(), &["mv", "old name.ts", "new name.ts"]);
    let snapshot = f.repo.snapshot(Mode::Diff, None).unwrap();
    assert_eq!(snapshot.files[0].status, "R");
    assert_eq!(snapshot.files[0].old_path.as_deref(), Some("old name.ts"));
    let file = f
        .repo
        .content(
            &snapshot.files[0].path,
            snapshot.files[0].old_path.as_deref(),
            &snapshot.context,
        )
        .unwrap();
    assert_eq!(file.old, file.new);
}

#[test]
fn pathspec_characters_are_literal_and_option_injection_is_rejected() {
    let f = Fixture::new();
    f.write("[a].txt", "literal");
    f.commit("initial");
    let context = f.repo.snapshot(Mode::Commit, None).unwrap().context;
    assert_eq!(
        f.repo
            .content("[a].txt", None, &context)
            .unwrap()
            .new
            .as_deref(),
        Some("literal")
    );
    for path in [
        "../outside",
        "/absolute",
        "C:/absolute",
        ".git/config",
        "nested/../../out",
        "nested\\out",
    ] {
        assert!(
            f.repo.content(path, None, &context).is_err(),
            "accepted {path}"
        );
    }
    assert!(f.repo.snapshot(Mode::Commit, Some("--all".into())).is_err());
    assert!(f
        .repo
        .snapshot(Mode::Commit, Some("missing-ref".into()))
        .is_err());
}

#[test]
fn binary_large_and_non_utf8_files_have_explicit_notices() {
    let f = Fixture::new();
    fs::write(f.dir.path().join("binary"), [0, 1, 2]).unwrap();
    fs::write(f.dir.path().join("legacy"), [255, 254]).unwrap();
    fs::write(f.dir.path().join("large"), vec![b'a'; 5 * 1024 * 1024 + 1]).unwrap();
    f.commit("initial");
    for mode in [Mode::Folder, Mode::Commit] {
        let context = f.repo.snapshot(mode, None).unwrap().context;
        for path in ["binary", "legacy", "large"] {
            let file = f.repo.content(path, None, &context).unwrap();
            assert!(file.new.is_none());
            assert!(file.new_notice.is_some());
        }
    }
}

#[test]
fn comments_round_trip_all_contexts_and_both_exports_replace_existing_files() {
    let f = Fixture::new();
    let mut doc = f.document();
    let paths = f.repo.save(&doc).unwrap();
    assert_eq!(
        paths[0],
        Path::new(&doc.root).join(JSON_FILE).display().to_string()
    );
    assert_eq!(
        paths[1],
        Path::new(&doc.root)
            .join(MARKDOWN_FILE)
            .display()
            .to_string()
    );
    doc.comments[0].text = "Revised\n```\n<literal>\n```".into();
    doc.comments[0].status = "resolved".into();
    f.repo.save(&doc).unwrap();
    let loaded = f.repo.opened().unwrap();
    assert_eq!(loaded.document.comments[0].text, doc.comments[0].text);
    assert_eq!(loaded.document.comments[0].side, "old");
    let md = fs::read_to_string(f.dir.path().join(MARKDOWN_FILE)).unwrap();
    assert!(md.contains("````text\nRevised"));
    assert!(md.contains("L2–L4"));
    assert!(md.contains("Status: resolved"));
    assert!(f.repo.snapshot(Mode::Diff, None).unwrap().files.is_empty());
    doc.comments.clear();
    f.repo.save(&doc).unwrap();
    assert!(f.repo.opened().unwrap().document.comments.is_empty());
}

#[test]
fn html_selection_round_trips_and_markdown_rendering_does_not_write_files() {
    let f = Fixture::new();
    let mut doc = f.document();
    doc.comments[0].path = "preview.html".into();
    doc.comments[0].line = None;
    doc.comments[0].end_line = None;
    doc.comments[0].quote = Some("Heading <literal>\n```\nselected text".into());
    let markdown = render_markdown(&doc);
    assert!(markdown.contains("HTML selection (old)"));
    assert!(markdown.contains("Selected HTML text:\n\n````text\nHeading <literal>"));
    assert!(!f.dir.path().join(JSON_FILE).exists());
    assert!(!f.dir.path().join(MARKDOWN_FILE).exists());
    f.repo.save(&doc).unwrap();
    assert_eq!(
        f.repo.opened().unwrap().document.comments[0].quote,
        doc.comments[0].quote
    );
    // Existing schema-v1 stores do not need a migration.
    let mut json = serde_json::to_value(&doc).unwrap();
    json["comments"][0].as_object_mut().unwrap().remove("quote");
    let legacy: Document = serde_json::from_value(json).unwrap();
    assert!(legacy.comments[0].quote.is_none());
    doc.comments[0].quote = Some("x".repeat(100001));
    assert!(f.repo.save(&doc).is_err());
    doc.comments[0].quote = Some("  ".into());
    assert!(f.repo.save(&doc).is_err());
}

#[test]
fn invalid_comment_store_is_not_silently_overwritten() {
    let f = Fixture::new();
    f.write(JSON_FILE, "not json");
    assert!(f.repo.opened().is_err());
    assert_eq!(
        fs::read_to_string(f.dir.path().join(JSON_FILE)).unwrap(),
        "not json"
    );
    let mut doc = f.document();
    doc.root = "some other folder".into();
    assert!(f.repo.save(&doc).is_err());
    doc.root = f.repo.root_string();
    doc.comments[0].line = Some(0);
    assert!(f.repo.save(&doc).is_err());
    doc.comments[0].line = Some(5);
    doc.comments[0].end_line = Some(2);
    assert!(f.repo.save(&doc).is_err());
}

#[test]
fn refuses_to_replace_directory_with_exports() {
    let f = Fixture::new();
    fs::create_dir(f.dir.path().join(MARKDOWN_FILE)).unwrap();
    assert!(f.repo.save(&f.document()).is_err());
    assert!(!f.dir.path().join(JSON_FILE).exists());
}

#[test]
fn symlinks_cannot_read_or_overwrite_outside_repository() {
    let f = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("private");
    fs::write(&target, "private").unwrap();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&target, f.dir.path().join("link"));
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&target, f.dir.path().join("link"));
    if let Err(error) = linked {
        // Windows machines without Developer Mode may deny symlink creation.
        eprintln!("Symlink fixture unavailable: {error}");
        return;
    }
    let context = f.repo.snapshot(Mode::Folder, None).unwrap().context;
    let file = f.repo.content("link", None, &context).unwrap();
    assert!(file.new.is_none());
    assert!(file.new_notice.unwrap().contains("Symbolic"));
    fs::rename(f.dir.path().join("link"), f.dir.path().join(JSON_FILE)).unwrap();
    assert!(f.repo.save(&f.document()).is_err());
    assert_eq!(fs::read_to_string(target).unwrap(), "private");
}

#[test]
fn linked_worktrees_are_supported() {
    let f = Fixture::new();
    f.write("file", "content");
    f.commit("initial");
    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().join("linked");
    git(
        f.dir.path(),
        &["worktree", "add", "-b", "review", path.to_str().unwrap()],
    );
    let repo = Repository::open(path.to_str().unwrap()).unwrap();
    assert_eq!(repo.snapshot(Mode::Folder, None).unwrap().files.len(), 1);
}

#[test]
fn images_are_encoded_from_working_tree_and_historical_git_blobs() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let f = Fixture::new();
    let png = include_bytes!("../../tests/fixtures/sample.png");
    let changed = include_bytes!("../../tests/fixtures/changed.png");
    let jpg = include_bytes!("../../tests/fixtures/sample.jpg");
    let webp = include_bytes!("../../tests/fixtures/sample.webp");
    for (name, bytes) in [
        ("sample.PNG", png.as_slice()),
        ("sample.jpeg", jpg.as_slice()),
        ("sample.webp", webp.as_slice()),
    ] {
        fs::write(f.dir.path().join(name), bytes).unwrap();
    }
    f.commit("images");
    fs::write(f.dir.path().join("sample.PNG"), changed).unwrap();
    let revision = f.commit("update artwork");
    fs::write(f.dir.path().join("sample.PNG"), png).unwrap();
    for mode in [Mode::Folder, Mode::Diff, Mode::Commit] {
        let snapshot = f
            .repo
            .snapshot(mode.clone(), Some(revision.clone()))
            .unwrap();
        for (name, mime, original) in [
            ("sample.PNG", "image/png", png.as_slice()),
            ("sample.jpeg", "image/jpeg", jpg.as_slice()),
            ("sample.webp", "image/webp", webp.as_slice()),
        ] {
            let content = f.repo.content(name, None, &snapshot.context).unwrap();
            assert!(content.new.is_none());
            assert!(content.new_notice.is_none());
            let expected = if mode == Mode::Commit && name == "sample.PNG" {
                changed.as_slice()
            } else {
                original
            };
            assert_eq!(
                content.new_image.unwrap(),
                format!("data:{mime};base64,{}", STANDARD.encode(expected))
            );
            if mode == Mode::Folder {
                assert!(content.old_image.is_none());
            }
        }
    }
    let context = f.repo.snapshot(Mode::Diff, None).unwrap().context;
    let content = f.repo.content("sample.PNG", None, &context).unwrap();
    assert_eq!(
        content.old_image.unwrap(),
        format!("data:image/png;base64,{}", STANDARD.encode(changed))
    );
}

#[test]
fn images_support_untracked_deleted_and_renamed_paths() {
    let f = Fixture::new();
    let png = include_bytes!("../../tests/fixtures/sample.png");
    fs::write(f.dir.path().join("deleted.png"), png).unwrap();
    fs::write(f.dir.path().join("old.png"), png).unwrap();
    f.commit("initial images");
    fs::remove_file(f.dir.path().join("deleted.png")).unwrap();
    git(f.dir.path(), &["mv", "old.png", "renamed.png"]);
    fs::write(f.dir.path().join("untracked.png"), png).unwrap();
    let snapshot = f.repo.snapshot(Mode::Diff, None).unwrap();
    let deleted = f
        .repo
        .content("deleted.png", None, &snapshot.context)
        .unwrap();
    assert!(deleted.old_image.is_some());
    assert!(deleted.new_image.is_none());
    let added = f
        .repo
        .content("untracked.png", None, &snapshot.context)
        .unwrap();
    assert!(added.old_image.is_none());
    assert!(added.new_image.is_some());
    let rename = snapshot
        .files
        .iter()
        .find(|f| f.path == "renamed.png")
        .unwrap();
    let renamed = f
        .repo
        .content(&rename.path, rename.old_path.as_deref(), &snapshot.context)
        .unwrap();
    assert!(renamed.old_image.is_some());
    assert_eq!(renamed.old_image, renamed.new_image);
}

#[test]
fn image_headers_and_size_limits_are_checked_before_returning_data() {
    let f = Fixture::new();
    f.write("fake.png", "<html><script>alert(1)</script></html>");
    fs::write(
        f.dir.path().join("wrong.webp"),
        include_bytes!("../../tests/fixtures/sample.jpg"),
    )
    .unwrap();
    fs::write(
        f.dir.path().join("large.jpg"),
        vec![0; 20 * 1024 * 1024 + 1],
    )
    .unwrap();
    f.commit("invalid image fixtures");
    for mode in [Mode::Folder, Mode::Commit] {
        let context = f.repo.snapshot(mode, None).unwrap().context;
        for path in ["fake.png", "wrong.webp", "large.jpg"] {
            let content = f.repo.content(path, None, &context).unwrap();
            assert!(content.new.is_none());
            assert!(content.new_image.is_none());
            let notice = content.new_notice.unwrap();
            assert!(notice.contains(if path == "large.jpg" {
                "20 MiB"
            } else {
                "Invalid image header"
            }));
        }
    }
}
