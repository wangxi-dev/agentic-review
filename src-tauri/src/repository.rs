use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
};

pub type Result<T> = std::result::Result<T, String>;
pub const JSON_FILE: &str = "agentic-review.comments.json";
pub const MARKDOWN_FILE: &str = "agentic-review.comments.md";
const MAX_FILE: u64 = 5 * 1024 * 1024;
const MAX_IMAGE: u64 = 20 * 1024 * 1024;
const MAX_COMMENTS: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Diff,
    Commit,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub mode: Mode,
    pub revision: Option<String>,
    pub base: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    pub context: Context,
    pub side: String,
    pub line: Option<u32>,
    pub end_line: Option<u32>,
    pub text: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub schema_version: u32,
    pub root: String,
    pub updated_at: String,
    pub comments: Vec<ReviewComment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub root: String,
    pub document: Document,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub context: Context,
    pub files: Vec<FileEntry>,
}

#[derive(Serialize)]
pub struct Commit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub old: Option<String>,
    pub new: Option<String>,
    pub old_notice: Option<String>,
    pub new_notice: Option<String>,
    pub old_image: Option<String>,
    pub new_image: Option<String>,
}

#[derive(Default)]
struct ContentPart {
    text: Option<String>,
    notice: Option<String>,
    image: Option<String>,
}

impl ContentPart {
    fn notice(message: impl Into<String>) -> Self {
        Self {
            notice: Some(message.into()),
            ..Self::default()
        }
    }
}

pub struct Repository {
    pub root: PathBuf,
}

fn output(root: &Path, args: &[&str]) -> Result<Output> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args([
            "--no-pager",
            "--no-replace-objects",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // No console window for Git commands.
    }
    command
        .output()
        .map_err(|e| format!("Cannot run Git. Install Git and ensure it is on PATH: {e}"))
}

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = output(root, args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(out.stdout)
}

fn text(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes).map_err(|_| {
        "Git returned a non-UTF-8 filename or metadata; this repository is not supported.".into()
    })
}

fn reserved(path: &str) -> bool {
    path.eq_ignore_ascii_case(JSON_FILE)
        || path.eq_ignore_ascii_case(MARKDOWN_FILE)
        || path.starts_with(".agentic-review-export-")
}

fn relative(path: &str) -> Result<()> {
    if path.is_empty()
        || path.contains(['\\', ':', '\0'])
        || !Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        || path
            .split('/')
            .any(|p| p == "." || p == ".." || p.eq_ignore_ascii_case(".git"))
    {
        return Err("Only repository-relative file paths are allowed.".into());
    }
    Ok(())
}

fn valid_hash(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn validate_context(context: &Context) -> Result<()> {
    for hash in [&context.base, &context.revision].into_iter().flatten() {
        if !valid_hash(hash) {
            return Err("Invalid review revision.".into());
        }
    }
    if context.mode == Mode::Commit && context.revision.is_none() {
        return Err("Commit mode requires a commit.".into());
    }
    Ok(())
}

impl Repository {
    pub fn open(path: &str) -> Result<Self> {
        let path = fs::canonicalize(path).map_err(|e| format!("Cannot open folder: {e}"))?;
        if !path.is_dir() {
            return Err("Choose a folder inside a Git working tree.".into());
        }
        let root = text(git(&path, &["rev-parse", "--show-toplevel"])?)?;
        let root = fs::canonicalize(root.trim_end_matches(['\r', '\n']))
            .map_err(|e| format!("Cannot open Git root: {e}"))?;
        Ok(Self { root })
    }

    pub fn root_string(&self) -> String {
        // Avoid the Windows verbatim path prefix in the UI and exported documents.
        let root = self.root.to_string_lossy();
        if let Some(unc) = root.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{unc}")
        } else {
            root.strip_prefix("\\\\?\\").unwrap_or(&root).to_owned()
        }
    }

    pub fn opened(&self) -> Result<Opened> {
        let path = self.root.join(JSON_FILE);
        let document = if path.try_exists().map_err(|e| e.to_string())? {
            self.safe_disk_path(JSON_FILE)?;
            let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
            if meta.len() > MAX_COMMENTS {
                return Err("Comment file exceeds the 20 MiB limit.".into());
            }
            let mut doc: Document = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Cannot load {JSON_FILE}: {e}. Fix or rename it before opening; it will not be overwritten."))?;
            validate_document(&doc)?;
            doc.root = self.root_string(); // A repository may have moved.
            doc
        } else {
            Document {
                schema_version: 1,
                root: self.root_string(),
                updated_at: String::new(),
                comments: vec![],
            }
        };
        Ok(Opened {
            root: self.root_string(),
            document,
        })
    }

    fn resolve(&self, revision: &str) -> Result<String> {
        if revision.is_empty()
            || revision.len() > 512
            || revision.starts_with('-')
            || revision.contains('\0')
        {
            return Err("Enter a valid commit hash, branch, or tag.".into());
        }
        Ok(text(git(
            &self.root,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{revision}^{{commit}}"),
            ],
        )?)?
        .trim()
        .to_owned())
    }

    fn head(&self) -> Result<Option<String>> {
        let out = output(&self.root, &["rev-parse", "--verify", "HEAD"])?;
        if out.status.success() {
            return Ok(Some(text(out.stdout)?.trim().to_owned()));
        }
        // Only an unborn branch is an empty baseline; don't hide arbitrary Git errors.
        let symbolic = output(&self.root, &["symbolic-ref", "-q", "HEAD"])?;
        if symbolic.status.success() {
            Ok(None)
        } else {
            Err(String::from_utf8_lossy(&out.stderr).into_owned())
        }
    }

    pub fn commits(&self) -> Result<Vec<Commit>> {
        if self.head()?.is_none() {
            return Ok(vec![]);
        }
        let log = text(git(
            &self.root,
            &[
                "log",
                "-200",
                "--format=%H%x00%s%x00%an%x00%aI%x00",
                "HEAD",
                "--",
            ],
        )?)?;
        let fields: Vec<_> = log.split('\0').collect();
        Ok(fields
            .as_chunks::<4>()
            .0
            .iter()
            .map(|f| Commit {
                hash: f[0].trim_start_matches('\n').to_owned(),
                subject: f[1].to_owned(),
                author: f[2].to_owned(),
                date: f[3].to_owned(),
            })
            .collect())
    }

    pub fn snapshot(&self, mode: Mode, revision: Option<String>) -> Result<Snapshot> {
        let (base, revision) = if mode == Mode::Commit {
            let rev = self.resolve(revision.as_deref().unwrap_or("HEAD"))?;
            let parents = text(git(
                &self.root,
                &["rev-list", "--parents", "-n", "1", &rev, "--"],
            )?)?;
            (
                parents.split_whitespace().nth(1).map(str::to_owned),
                Some(rev),
            )
        } else {
            (self.head()?, None)
        };
        let context = Context {
            mode,
            base,
            revision,
        };
        let mut entries = BTreeMap::new();
        if context.mode == Mode::Folder {
            for path in self.working_files()? {
                if self.root.join(&path).symlink_metadata().is_ok() {
                    entries.insert(
                        path.clone(),
                        FileEntry {
                            path,
                            old_path: None,
                            status: String::new(),
                        },
                    );
                }
            }
        } else if let Some(base) = &context.base {
            let mut args = vec![
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--name-status",
                "-z",
                "--find-renames",
                base,
            ];
            if let Some(rev) = &context.revision {
                args.push(rev);
            }
            args.push("--");
            let raw = text(git(&self.root, &args)?)?;
            for entry in parse_status(&raw)? {
                entries.insert(entry.path.clone(), entry);
            }
        } else if let Some(rev) = &context.revision {
            let raw = text(git(
                &self.root,
                &["ls-tree", "-r", "--name-only", "-z", rev, "--"],
            )?)?;
            for path in raw.split('\0').filter(|p| !p.is_empty()) {
                entries.insert(
                    path.to_owned(),
                    FileEntry {
                        path: path.to_owned(),
                        old_path: None,
                        status: "A".into(),
                    },
                );
            }
        } else {
            for path in self.working_files()? {
                entries.insert(
                    path.clone(),
                    FileEntry {
                        path,
                        old_path: None,
                        status: "A".into(),
                    },
                );
            }
        }
        if context.mode == Mode::Diff {
            let raw = text(git(
                &self.root,
                &["ls-files", "--others", "--exclude-standard", "-z", "--"],
            )?)?;
            for path in raw.split('\0').filter(|p| !p.is_empty()) {
                entries.entry(path.to_owned()).or_insert(FileEntry {
                    path: path.to_owned(),
                    old_path: None,
                    status: "?".into(),
                });
            }
        }
        Ok(Snapshot {
            context,
            files: entries
                .into_values()
                .filter(|f| !reserved(&f.path))
                .collect(),
        })
    }

    fn working_files(&self) -> Result<Vec<String>> {
        let raw = text(git(
            &self.root,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
            ],
        )?)?;
        Ok(raw
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect())
    }

    fn safe_disk_path(&self, path: &str) -> Result<PathBuf> {
        relative(path)?;
        let mut current = self.root.clone();
        for part in Path::new(path).components() {
            current.push(part);
            match fs::symlink_metadata(&current) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        return Err("Symbolic links are not opened or overwritten.".into());
                    }
                    let canonical = fs::canonicalize(&current).map_err(|e| e.to_string())?;
                    if !canonical.starts_with(&self.root) {
                        return Err("Path escapes the opened repository.".into());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(self.root.join(path))
    }

    fn disk_content(&self, path: &str) -> Result<ContentPart> {
        let disk_path = match self.safe_disk_path(path) {
            Ok(path) => path,
            Err(e) => return Ok(ContentPart::notice(e)),
        };
        let meta = match fs::metadata(&disk_path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ContentPart::default()),
            Err(e) => return Err(format!("Cannot read file: {e}")),
        };
        if !meta.is_file() {
            return Ok(ContentPart::notice("Directory or submodule — no preview."));
        }
        if meta.len() > preview_limit(path) {
            return Ok(ContentPart::notice(size_notice(path)));
        }
        Ok(decode_content(
            fs::read(disk_path).map_err(|e| e.to_string())?,
            path,
        ))
    }

    fn blob_content(&self, revision: Option<&str>, path: &str) -> Result<ContentPart> {
        relative(path)?;
        let Some(rev) = revision else {
            return Ok(ContentPart::default());
        };
        let listing = text(git(&self.root, &["ls-tree", "-z", rev, "--", path])?)?;
        let Some(record) = listing
            .split('\0')
            .find(|r| r.split_once('\t').is_some_and(|(_, p)| p == path))
        else {
            return Ok(ContentPart::default());
        };
        let metadata: Vec<_> = record
            .split_once('\t')
            .unwrap()
            .0
            .split_whitespace()
            .collect();
        if metadata.len() != 3 {
            return Err("Invalid Git tree entry.".into());
        }
        if metadata[1] != "blob" || !matches!(metadata[0], "100644" | "100755") {
            return Ok(ContentPart::notice(
                "Symbolic link, directory, or submodule — no preview.",
            ));
        }
        let size = text(git(&self.root, &["cat-file", "-s", metadata[2]])?)?
            .trim()
            .parse::<u64>()
            .map_err(|e| e.to_string())?;
        if size > preview_limit(path) {
            return Ok(ContentPart::notice(size_notice(path)));
        }
        Ok(decode_content(
            git(&self.root, &["cat-file", "blob", metadata[2]])?,
            path,
        ))
    }

    pub fn content(
        &self,
        path: &str,
        old_path: Option<&str>,
        context: &Context,
    ) -> Result<FileContent> {
        relative(path)?;
        validate_context(context)?;
        let old = if context.mode == Mode::Folder {
            ContentPart::default()
        } else {
            self.blob_content(context.base.as_deref(), old_path.unwrap_or(path))?
        };
        let new = if context.mode == Mode::Commit {
            self.blob_content(context.revision.as_deref(), path)?
        } else {
            self.disk_content(path)?
        };
        Ok(FileContent {
            old: old.text,
            new: new.text,
            old_notice: old.notice,
            new_notice: new.notice,
            old_image: old.image,
            new_image: new.image,
        })
    }

    pub fn save(&self, document: &Document) -> Result<Vec<String>> {
        if document.root != self.root_string() {
            return Err("Repository changed; refusing to save comments to another folder.".into());
        }
        validate_document(document)?;
        let mut json = serde_json::to_vec_pretty(document).map_err(|e| e.to_string())?;
        json.push(b'\n');
        if json.len() as u64 > MAX_COMMENTS {
            return Err("Comments exceed the 20 MiB limit.".into());
        }
        let markdown = render_markdown(document);
        // Validate BOTH destinations before writing either one.
        for name in [JSON_FILE, MARKDOWN_FILE] {
            let path = self.safe_disk_path(name)?;
            if path.exists() && !path.is_file() {
                return Err(format!("{name} is not a regular file."));
            }
        }
        for (name, bytes) in [
            (JSON_FILE, json.as_slice()),
            (MARKDOWN_FILE, markdown.as_bytes()),
        ] {
            let mut temp = tempfile::Builder::new()
                .prefix(".agentic-review-export-")
                .tempfile_in(&self.root)
                .map_err(|e| format!("Cannot create comments in the repository root: {e}"))?;
            temp.write_all(bytes)
                .and_then(|_| temp.as_file().sync_all())
                .map_err(|e| e.to_string())?;
            temp.persist(self.root.join(name))
                .map_err(|e| format!("Cannot save {name}: {e}"))?;
        }
        Ok(vec![
            self.root.join(JSON_FILE).display().to_string(),
            self.root.join(MARKDOWN_FILE).display().to_string(),
        ])
    }
}

fn image_mime(path: &str) -> Option<&'static str> {
    match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn preview_limit(path: &str) -> u64 {
    if image_mime(path).is_some() {
        MAX_IMAGE
    } else {
        MAX_FILE
    }
}

fn size_notice(path: &str) -> &'static str {
    if image_mime(path).is_some() {
        "Image exceeds the 20 MiB preview limit."
    } else {
        "File exceeds the 5 MiB preview limit."
    }
}

fn decode_content(bytes: Vec<u8>, path: &str) -> ContentPart {
    if bytes.len() as u64 > preview_limit(path) {
        return ContentPart::notice(size_notice(path));
    }
    if let Some(mime) = image_mime(path) {
        // Never expose arbitrary bytes as an active document or trust just the extension.
        let valid = match mime {
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
            "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            _ => false,
        };
        return if valid {
            ContentPart {
                image: Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes))),
                ..ContentPart::default()
            }
        } else {
            ContentPart::notice("Invalid image header: expected PNG, JPEG, or WebP data matching the file extension.")
        };
    }
    if bytes.contains(&0) {
        return ContentPart::notice("Binary file — no text preview.");
    }
    match String::from_utf8(bytes) {
        Ok(value) => ContentPart {
            text: Some(value),
            ..ContentPart::default()
        },
        Err(_) => ContentPart::notice("Non-UTF-8 file — no text preview."),
    }
}

fn parse_status(raw: &str) -> Result<Vec<FileEntry>> {
    let mut fields = raw.split('\0').filter(|p| !p.is_empty());
    let mut entries = vec![];
    while let Some(status) = fields.next() {
        let path = fields.next().ok_or("Invalid Git change list.")?;
        let rename = status.starts_with(['R', 'C']);
        let (path, old_path) = if rename {
            (
                fields.next().ok_or("Invalid Git rename entry.")?,
                Some(path.to_owned()),
            )
        } else {
            (path, None)
        };
        entries.push(FileEntry {
            path: path.to_owned(),
            old_path,
            status: status.chars().take(1).collect(),
        });
    }
    Ok(entries)
}

fn validate_document(doc: &Document) -> Result<()> {
    if doc.schema_version != 1 {
        return Err("Unsupported comment schema version.".into());
    }
    if doc.comments.len() > 10000 {
        return Err("Too many comments (maximum 10,000).".into());
    }
    let mut ids = std::collections::HashSet::new();
    for c in &doc.comments {
        relative(&c.path)?;
        if let Some(path) = &c.old_path {
            relative(path)?;
        }
        validate_context(&c.context)?;
        if c.id.is_empty()
            || !ids.insert(&c.id)
            || c.text.trim().is_empty()
            || c.text.len() > 100000
            || !matches!(c.status.as_str(), "open" | "resolved")
            || !matches!(c.side.as_str(), "old" | "new")
            || c.line == Some(0)
            || c.end_line
                .is_some_and(|n| c.line.is_none_or(|start| n < start))
        {
            return Err("Invalid comment: check ID, text, status, side, and line range.".into());
        }
    }
    Ok(())
}

fn md_escape(value: &str) -> String {
    let mut result = String::new();
    for ch in value.chars() {
        match ch {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '\r' | '\n' => result.push(' '),
            '\\' | '`' | '*' | '_' | '[' | ']' | '#' | '|' => {
                result.push('\\');
                result.push(ch);
            }
            _ => result.push(ch),
        }
    }
    result
}

pub fn render_markdown(doc: &Document) -> String {
    let mut result = format!("# Review comments\n\nRepository: {}\n\nUpdated: {}\n\n{} comment(s). Line numbers refer to the recorded review snapshot, not necessarily the current working tree.\n", md_escape(&doc.root), md_escape(&doc.updated_at), doc.comments.len());
    for c in &doc.comments {
        let mode = match c.context.mode {
            Mode::Diff => "Git diff",
            Mode::Commit => "Git commit",
            Mode::Folder => "Full folder",
        };
        let anchor = c
            .line
            .map(|n| {
                c.end_line
                    .filter(|end| *end != n)
                    .map(|end| format!("L{n}–L{end}"))
                    .unwrap_or(format!("L{n}"))
            })
            .unwrap_or("File".into());
        result.push_str(&format!("\n## {} — {} ({})\n\n- Status: {}\n- Review: {}\n- Anchor: {} ({})\n- Revision: {}\n- Base: {}\n- ID: {}\n- Created: {}\n- Updated: {}\n\n", md_escape(&c.path), anchor, c.side, c.status, mode, anchor, c.side, c.context.revision.as_deref().unwrap_or("working tree"), c.context.base.as_deref().unwrap_or("empty tree"), md_escape(&c.id), md_escape(&c.created_at), md_escape(&c.updated_at)));
        if let Some(old_path) = &c.old_path {
            result.push_str(&format!("Previous path: {}\n\n", md_escape(old_path)));
        }
        // Literal fenced text preserves arbitrary Markdown/HTML and even nested fences.
        let fence = "`".repeat(
            c.text
                .split(|ch| ch != '`')
                .map(str::len)
                .max()
                .unwrap_or(0)
                .max(2)
                + 1,
        );
        result.push_str(&format!("{fence}text\n{}\n{fence}\n", c.text));
    }
    result
}
