//! In-memory structural matching powered by ast-grep (used by TTSR rules).

use std::{
	cmp::Ordering,
	collections::{BTreeSet, BinaryHeap, HashMap},
};

use ast_grep_core::{MatchStrictness, matcher::Pattern, tree_sitter::LanguageExt};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_ast::{
	SupportLang,
	language::grammar::LanguageGrammar,
	ops::{self as shared_ops},
};

use crate::task;

const DEFAULT_FIND_LIMIT: u32 = 50;

/// ast-grep pattern strictness (controls how patterns match syntax).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum AstMatchStrictness {
	/// Match at the concrete syntax tree level.
	#[napi(value = "cst")]
	Cst,
	/// Balanced default suitable for most searches.
	#[napi(value = "smart")]
	Smart,
	/// Match at the AST level.
	#[napi(value = "ast")]
	Ast,
	/// More permissive matching.
	#[napi(value = "relaxed")]
	Relaxed,
	/// Match structural signatures.
	#[napi(value = "signature")]
	Signature,
	/// Template-style pattern matching.
	#[napi(value = "template")]
	Template,
}

impl From<AstMatchStrictness> for MatchStrictness {
	fn from(value: AstMatchStrictness) -> Self {
		match value {
			AstMatchStrictness::Cst => Self::Cst,
			AstMatchStrictness::Smart => Self::Smart,
			AstMatchStrictness::Ast => Self::Ast,
			AstMatchStrictness::Relaxed => Self::Relaxed,
			AstMatchStrictness::Signature => Self::Signature,
			AstMatchStrictness::Template => Self::Template,
		}
	}
}

fn resolve_strictness(value: Option<AstMatchStrictness>) -> MatchStrictness {
	value.map_or(MatchStrictness::Smart, Into::into)
}

/// One ast-grep match with source range and optional meta-variables.
#[napi(object)]
pub struct AstFindMatch {
	/// Display path of the matching file.
	pub path:           String,
	/// Matched source text.
	pub text:           String,
	/// Start byte offset in the file (UTF-8 byte index).
	pub byte_start:     u32,
	/// End byte offset in the file (exclusive UTF-8 byte index).
	pub byte_end:       u32,
	/// 1-based start line.
	pub start_line:     u32,
	/// 1-based start column.
	pub start_column:   u32,
	/// 1-based end line.
	pub end_line:       u32,
	/// 1-based end column.
	pub end_column:     u32,
	/// Meta-variable name to captured text, when `includeMeta` was enabled.
	pub meta_variables: Option<HashMap<String, String>>,
}

#[derive(Clone, Eq, PartialEq)]
struct AstFindOrderKey {
	path:         String,
	start_line:   u32,
	start_column: u32,
	end_line:     u32,
	end_column:   u32,
	byte_start:   u32,
	byte_end:     u32,
	sequence:     u64,
}

impl Ord for AstFindOrderKey {
	fn cmp(&self, other: &Self) -> Ordering {
		self
			.path
			.cmp(&other.path)
			.then(self.start_line.cmp(&other.start_line))
			.then(self.start_column.cmp(&other.start_column))
			.then(self.end_line.cmp(&other.end_line))
			.then(self.end_column.cmp(&other.end_column))
			.then(self.byte_start.cmp(&other.byte_start))
			.then(self.byte_end.cmp(&other.byte_end))
			.then(self.sequence.cmp(&other.sequence))
	}
}

impl PartialOrd for AstFindOrderKey {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

#[derive(Eq, PartialEq)]
struct RetainedAstFindMatch {
	key:            AstFindOrderKey,
	text:           String,
	meta_variables: Option<HashMap<String, String>>,
}

impl Ord for RetainedAstFindMatch {
	fn cmp(&self, other: &Self) -> Ordering {
		self.key.cmp(&other.key)
	}
}

impl PartialOrd for RetainedAstFindMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

fn retained_find_capacity(offset: u32, limit: u32) -> usize {
	usize::try_from(offset.saturating_add(limit).saturating_add(1)).unwrap_or(usize::MAX)
}

fn should_retain_match(
	retained: &BinaryHeap<RetainedAstFindMatch>,
	capacity: usize,
	key: &AstFindOrderKey,
) -> bool {
	if retained.len() < capacity {
		return true;
	}
	retained
		.peek()
		.is_some_and(|worst_retained| key.cmp(&worst_retained.key).is_lt())
}

fn retain_bounded_match(
	retained: &mut BinaryHeap<RetainedAstFindMatch>,
	capacity: usize,
	candidate: RetainedAstFindMatch,
) {
	if retained.len() < capacity {
		retained.push(candidate);
		return;
	}
	if let Some(mut worst_retained) = retained.peek_mut()
		&& candidate.key.cmp(&worst_retained.key).is_lt()
	{
		*worst_retained = candidate;
	}
}

fn page_retained_matches(
	retained: BinaryHeap<RetainedAstFindMatch>,
	offset: u32,
	limit: u32,
) -> (Vec<RetainedAstFindMatch>, bool) {
	let mut retained_matches = retained.into_vec();
	retained_matches.sort_by(|left, right| left.key.cmp(&right.key));
	let offset = usize::try_from(offset).unwrap_or(usize::MAX);
	let limit = usize::try_from(limit).unwrap_or(usize::MAX);
	let limit_reached = retained_matches.len().saturating_sub(offset) > limit;
	let matches = retained_matches
		.into_iter()
		.skip(offset)
		.take(limit)
		.collect::<Vec<_>>();
	(matches, limit_reached)
}

fn retained_to_find_match(retained: RetainedAstFindMatch) -> AstFindMatch {
	let RetainedAstFindMatch { key, text, meta_variables } = retained;
	AstFindMatch {
		path: key.path,
		text,
		byte_start: key.byte_start,
		byte_end: key.byte_end,
		start_line: key.start_line,
		start_column: key.start_column,
		end_line: key.end_line,
		end_column: key.end_column,
		meta_variables,
	}
}

/// Options for `astMatch`: run ast-grep patterns against an in-memory source
/// string instead of files on disk.
#[napi(object)]
pub struct AstMatchOptions<'env> {
	/// Source code to match against (parsed in memory, never read from disk).
	pub source:       String,
	/// Language of `source` (required; e.g. "ts", "tsx", "rust", "python").
	pub lang:         String,
	/// ast-grep patterns to search for (OR across patterns).
	pub patterns:     Vec<String>,
	/// Rule selector for multi-rule ast-grep configurations.
	pub selector:     Option<String>,
	/// Pattern strictness; defaults to smart matching when omitted.
	pub strictness:   Option<AstMatchStrictness>,
	/// Maximum matches to return after `offset` (default applies when omitted).
	pub limit:        Option<u32>,
	/// Number of leading matches to skip before applying `limit`.
	pub offset:       Option<u32>,
	/// When true, include meta-variable bindings per match.
	pub include_meta: Option<bool>,
	/// Optional cancellation handle (library-specific).
	pub signal:       Option<Unknown<'env>>,
	/// Wall-clock timeout for the worker task in milliseconds.
	pub timeout_ms:   Option<u32>,
}

/// Result of an in-memory `astMatch` run.
#[napi(object)]
pub struct AstMatchResult {
	/// Page of matches after sort, offset, and limit.
	pub matches:       Vec<AstFindMatch>,
	/// Total matches found before paging (can exceed `matches.length`).
	pub total_matches: u32,
	/// True when results were truncated by `limit`.
	pub limit_reached: bool,
	/// Non-fatal parse or pattern-compile errors collected during the run.
	pub parse_errors:  Option<Vec<String>>,
}

fn to_u32(value: usize) -> u32 {
	value.min(u32::MAX as usize) as u32
}

fn resolve_supported_lang(value: &str) -> Result<SupportLang> {
	shared_ops::resolve_supported_lang(value).map_err(|err| Error::from_reason(err.to_string()))
}

fn compile_pattern(
	pattern: &str,
	selector: Option<&str>,
	strictness: &MatchStrictness,
	lang: SupportLang,
) -> Result<Pattern> {
	shared_ops::compile_pattern(pattern, selector, strictness, lang)
		.map_err(|err| Error::from_reason(err.to_string()))
}

fn normalize_pattern_list(patterns: Option<Vec<String>>) -> Result<Vec<String>> {
	let mut normalized = Vec::new();
	let mut seen = BTreeSet::new();
	for raw in patterns.unwrap_or_default() {
		let pattern = raw.trim();
		if pattern.is_empty() || seen.contains(pattern) {
			continue;
		}
		let owned = if pattern.len() == raw.len() {
			raw
		} else {
			pattern.to_string()
		};
		seen.insert(owned.clone());
		normalized.push(owned);
	}
	if normalized.is_empty() {
		return Err(Error::from_reason(
			"`patterns` is required and must include at least one non-empty pattern".to_string(),
		));
	}
	Ok(normalized)
}

/// Match ast-grep patterns against an in-memory source string; returns a
/// promise resolved on a worker thread.
///
/// `lang` is required since there is no file path to infer it from.
#[napi]
pub fn ast_match(options: AstMatchOptions<'_>) -> task::Promise<AstMatchResult> {
	let AstMatchOptions {
		source,
		lang,
		patterns,
		selector,
		strictness,
		limit,
		offset,
		include_meta,
		signal,
		timeout_ms,
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	let normalized_limit = limit.unwrap_or(DEFAULT_FIND_LIMIT).max(1);
	let normalized_offset = offset.unwrap_or(0);

	task::blocking("ast_match", ct, move |ct| {
		let patterns = normalize_pattern_list(Some(patterns))?;
		let strictness = resolve_strictness(strictness);
		let include_meta = include_meta.unwrap_or(false);
		let lang_str = lang.trim();
		if lang_str.is_empty() {
			return Err(Error::from_reason("`lang` is required for ast_match".to_string()));
		}
		let language = resolve_supported_lang(lang_str)?;
		language
			.grammar()
			.load()
			.map_err(|err| Error::from_reason(err.to_string()))?;

		let mut parse_errors = Vec::new();
		let mut compiled_patterns = Vec::with_capacity(patterns.len());
		for pattern in &patterns {
			ct.heartbeat()?;
			match compile_pattern(pattern, selector.as_deref(), &strictness, language) {
				Ok(compiled) => compiled_patterns.push(compiled),
				Err(err) => parse_errors.push(format!("{pattern}: {err}")),
			}
		}

		let retained_capacity = retained_find_capacity(normalized_offset, normalized_limit);
		let mut retained_matches = BinaryHeap::new();
		let mut total_matches = 0u32;
		let mut match_sequence = 0u64;
		if !compiled_patterns.is_empty() {
			let ast = language.ast_grep(&source);
			if ast.root().dfs().any(|node| node.is_error()) {
				parse_errors.push("parse error (syntax tree contains error nodes)".to_string());
			}
			for pattern in &compiled_patterns {
				ct.heartbeat()?;
				for matched in ast.root().find_all(pattern.clone()) {
					ct.heartbeat()?;
					total_matches = total_matches.saturating_add(1);
					let range = matched.range();
					let start = matched.start_pos();
					let end = matched.end_pos();
					let key = AstFindOrderKey {
						path:         String::new(),
						start_line:   to_u32(start.line().saturating_add(1)),
						start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
						end_line:     to_u32(end.line().saturating_add(1)),
						end_column:   to_u32(end.column(matched.get_node()).saturating_add(1)),
						byte_start:   to_u32(range.start),
						byte_end:     to_u32(range.end),
						sequence:     match_sequence,
					};
					match_sequence = match_sequence.saturating_add(1);
					if should_retain_match(&retained_matches, retained_capacity, &key) {
						let meta_variables = if include_meta {
							Some(HashMap::<String, String>::from(matched.get_env().clone()))
						} else {
							None
						};
						retain_bounded_match(
							&mut retained_matches,
							retained_capacity,
							RetainedAstFindMatch {
								key,
								text: matched.text().into_owned(),
								meta_variables,
							},
						);
					}
				}
			}
		}

		let (matches, limit_reached) =
			page_retained_matches(retained_matches, normalized_offset, normalized_limit);
		let matches = matches
			.into_iter()
			.map(retained_to_find_match)
			.collect::<Vec<_>>();

		Ok(AstMatchResult {
			matches,
			total_matches,
			limit_reached,
			parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
		})
	})
}

/// Apply ast-grep rewrite rules to matching files; honors `dryRun` and returns
/// a promise.

#[cfg(test)]
mod tests {
	use super::*;

	fn retained_test_match(line: u32) -> RetainedAstFindMatch {
		RetainedAstFindMatch {
			key:            AstFindOrderKey {
				path:         "file.ts".to_string(),
				start_line:   line,
				start_column: 1,
				end_line:     line,
				end_column:   2,
				byte_start:   line - 1,
				byte_end:     line,
				sequence:     u64::from(line),
			},
			text:           String::new(),
			meta_variables: None,
		}
	}

	#[test]
	fn retained_find_matches_keep_only_page_window() {
		let capacity = retained_find_capacity(1, 2);
		let mut retained = BinaryHeap::new();
		let mut materialized_payloads = 0usize;
		for line in 1..=100 {
			let candidate = retained_test_match(line);
			if should_retain_match(&retained, capacity, &candidate.key) {
				materialized_payloads += 1;
				retain_bounded_match(&mut retained, capacity, candidate);
			}
		}

		let (page, limit_reached) = page_retained_matches(retained, 1, 2);
		let lines = page
			.into_iter()
			.map(|retained| retained.key.start_line)
			.collect::<Vec<_>>();

		assert_eq!(materialized_payloads, capacity);
		assert!(limit_reached);
		assert_eq!(lines, vec![2, 3]);
	}

	#[test]
	fn resolves_supported_language_aliases() {
		assert_eq!(resolve_supported_lang("ts").ok(), Some(SupportLang::TypeScript));
		assert_eq!(resolve_supported_lang("jsx").ok(), Some(SupportLang::JavaScript));
		assert_eq!(resolve_supported_lang("rs").ok(), Some(SupportLang::Rust));
		assert_eq!(resolve_supported_lang("kotlin").ok(), Some(SupportLang::Kotlin));
		assert_eq!(resolve_supported_lang("bash").ok(), Some(SupportLang::Bash));
		assert_eq!(resolve_supported_lang("c").ok(), Some(SupportLang::C));
		assert_eq!(resolve_supported_lang("cpp").ok(), Some(SupportLang::Cpp));
		assert_eq!(resolve_supported_lang("tla").ok(), Some(SupportLang::Tlaplus));
		assert_eq!(resolve_supported_lang("pluscal").ok(), Some(SupportLang::Tlaplus));
		assert_eq!(resolve_supported_lang("emacs-lisp").ok(), Some(SupportLang::EmacsLisp));
		assert_eq!(resolve_supported_lang("elisp").ok(), Some(SupportLang::EmacsLisp));
		assert_eq!(resolve_supported_lang("el").ok(), Some(SupportLang::EmacsLisp));
		assert_eq!(resolve_supported_lang("f90").ok(), Some(SupportLang::Fortran));
		assert!(resolve_supported_lang("brainfuck").is_err());
	}
}
