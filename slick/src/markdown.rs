use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};

const FG: Color = Color::Rgb(0xdd, 0xdd, 0xe7);
const MUTED: Color = Color::Rgb(0x8f, 0x8f, 0xa3);
const ACCENT: Color = Color::Rgb(0x7c, 0x5c, 0xfc);
const CYAN: Color = Color::Rgb(0x4d, 0xd9, 0xe8);
const GREEN: Color = Color::Rgb(0x6f, 0xd4, 0x9d);
const YELLOW: Color = Color::Rgb(0xf2, 0xc7, 0x66);

#[derive(Clone, Copy)]
struct InlineStyle {
    style: Style,
}

impl Default for InlineStyle {
    fn default() -> Self {
        Self {
            style: Style::default().fg(FG),
        }
    }
}

fn push_text(spans: &mut Vec<Span<'static>>, value: impl Into<String>, style: Style) {
    let value = value.into();
    if !value.is_empty() {
        spans.push(Span::styled(value, style));
    }
}

fn flush(lines: &mut Vec<Line<'static>>, spans: &mut Vec<Span<'static>>) {
    if spans.is_empty() {
        if lines.last().is_none_or(|line| !line.spans.is_empty()) {
            lines.push(Line::default());
        }
    } else {
        // Emoji arrive as alt text immediately followed by the literal
        // shortcode; collapse the duplicate once the line is complete.
        let collapsed: Vec<Span<'static>> = std::mem::take(spans)
            .into_iter()
            .map(|span| {
                let content = collapse_repeated_shortcodes(&span.content);
                Span::styled(content, span.style)
            })
            .collect();
        lines.push(Line::from(collapsed));
    }
}

/// Cell placeholder that reserves space for an inline image.
///
/// A unicode emoji occupies two cells, so an emoji placement reserves exactly
/// two: the object-replacement character plus one padding cell. The renderer
/// then draws the image over those cells, leaving the surrounding sentence
/// byte-for-byte identical to the glyph case.
pub const IMAGE_PLACEHOLDER: char = '\u{fffc}';

/// One image referenced by rendered Markdown, in document order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImagePlacement {
    /// Emoji (punctuation) or attachment (content).
    pub kind: ImageKind,
    /// Source URL to fetch.
    pub url: String,
    /// Alt text, used as the accessible fallback label.
    pub alt: String,
}

#[must_use]
pub fn render_markdown(source: &str) -> Text<'static> {
    render_markdown_with_images(source).0
}

/// Render Markdown and report the images it references, in document order.
///
/// Callers that can draw terminal graphics pair the returned placements with
/// the [`IMAGE_PLACEHOLDER`] cells in the rendered buffer; callers that cannot
/// simply ignore them and see the textual fallback.
#[must_use]
pub fn render_markdown_with_images(source: &str) -> (Text<'static>, Vec<ImagePlacement>) {
    render_markdown_for(source, false)
}

/// Render Markdown for a target that can (or cannot) draw the images.
///
/// When `graphics` is set the emoji image itself is the symbol, so the literal
/// shortcode Slack repeats immediately after it is swallowed: the sentence then
/// reads exactly as it would with a unicode glyph. Without graphics the
/// shortcode is the only representation and is kept.
#[must_use]
pub fn render_markdown_for(source: &str, graphics: bool) -> (Text<'static>, Vec<ImagePlacement>) {
    let parser = Parser::new_ext(
        source,
        Options::ENABLE_TABLES
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_FOOTNOTES,
    );
    let mut lines = Vec::new();
    let mut spans = Vec::new();
    let mut inline = vec![InlineStyle::default()];
    let mut list_depth = 0usize;
    let mut ordered_lists: Vec<Option<u64>> = Vec::new();
    let mut quote_depth = 0usize;
    let mut in_code_block = false;
    let mut link_target = None::<String>;
    let mut image_kind = None::<ImageKind>;
    let mut images: Vec<ImagePlacement> = Vec::new();
    let mut image_alt = String::new();
    let mut swallow_shortcode: Option<String> = None;

    for event in parser {
        let current = inline.last().copied().unwrap_or_default().style;
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut lines, &mut spans);
                let (color, modifier) = match level {
                    HeadingLevel::H1 => (YELLOW, Modifier::BOLD),
                    HeadingLevel::H2 => (CYAN, Modifier::BOLD),
                    _ => (ACCENT, Modifier::BOLD),
                };
                inline.push(InlineStyle {
                    style: Style::default().fg(color).add_modifier(modifier),
                });
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(&mut lines, &mut spans);
                let _ = inline.pop();
                lines.push(Line::default());
            }
            Event::Start(Tag::Paragraph) if quote_depth > 0 && spans.is_empty() => {
                push_text(
                    &mut spans,
                    "▌ ".repeat(quote_depth),
                    Style::default().fg(ACCENT),
                );
            }
            Event::End(TagEnd::Paragraph) => {
                flush(&mut lines, &mut spans);
                if list_depth == 0 && quote_depth == 0 {
                    lines.push(Line::default());
                }
            }
            Event::Start(Tag::Emphasis) => inline.push(InlineStyle {
                style: current.add_modifier(Modifier::ITALIC),
            }),
            Event::Start(Tag::Strong) => inline.push(InlineStyle {
                style: current.add_modifier(Modifier::BOLD),
            }),
            Event::Start(Tag::Strikethrough) => inline.push(InlineStyle {
                style: current.add_modifier(Modifier::CROSSED_OUT),
            }),
            Event::End(TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough) => {
                let _ = inline.pop();
            }
            Event::Start(Tag::BlockQuote(_)) => {
                quote_depth = quote_depth.saturating_add(1);
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                quote_depth = quote_depth.saturating_sub(1);
                flush(&mut lines, &mut spans);
            }
            Event::Start(Tag::List(start)) => {
                list_depth = list_depth.saturating_add(1);
                ordered_lists.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                list_depth = list_depth.saturating_sub(1);
                let _ = ordered_lists.pop();
                flush(&mut lines, &mut spans);
            }
            Event::Start(Tag::Item) => {
                flush(&mut lines, &mut spans);
                push_text(
                    &mut spans,
                    "  ".repeat(list_depth.saturating_sub(1)),
                    current,
                );
                let marker = ordered_lists
                    .last_mut()
                    .and_then(Option::as_mut)
                    .map_or_else(
                        || "• ".to_string(),
                        |number| {
                            let marker = format!("{number}. ");
                            *number = number.saturating_add(1);
                            marker
                        },
                    );
                push_text(&mut spans, marker, Style::default().fg(CYAN));
            }
            Event::End(TagEnd::Item | TagEnd::TableRow)
            | Event::Start(Tag::Table(_))
            | Event::SoftBreak
            | Event::HardBreak => flush(&mut lines, &mut spans),
            Event::Start(Tag::CodeBlock(kind)) => {
                flush(&mut lines, &mut spans);
                in_code_block = true;
                let code_language = match kind {
                    CodeBlockKind::Fenced(language) if !language.is_empty() => {
                        Some(language.to_string())
                    }
                    _ => None,
                };
                if let Some(language) = &code_language {
                    push_text(
                        &mut spans,
                        format!(" {language} "),
                        Style::default()
                            .fg(Color::Black)
                            .bg(CYAN)
                            .add_modifier(Modifier::BOLD),
                    );
                    flush(&mut lines, &mut spans);
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                flush(&mut lines, &mut spans);
                in_code_block = false;
                lines.push(Line::default());
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                link_target = Some(dest_url.to_string());
                inline.push(InlineStyle {
                    style: current
                        .fg(CYAN)
                        .add_modifier(Modifier::UNDERLINED | Modifier::BOLD),
                });
            }
            Event::End(TagEnd::Link) => {
                let _ = inline.pop();
                if let Some(target) = link_target.take() {
                    push_text(
                        &mut spans,
                        format!(" ↗{target}"),
                        Style::default().fg(MUTED).add_modifier(Modifier::DIM),
                    );
                }
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                let kind = classify_image(&dest_url);
                image_kind = Some(kind);
                image_alt.clear();
                images.push(ImagePlacement {
                    kind,
                    url: dest_url.to_string(),
                    alt: String::new(),
                });
                match kind {
                    // Reserve exactly the two cells a unicode emoji occupies so
                    // a graphics-capable renderer can draw over them without
                    // moving a single surrounding character.
                    ImageKind::Emoji => push_text(
                        &mut spans,
                        format!("{IMAGE_PLACEHOLDER} "),
                        Style::default().fg(FG),
                    ),
                    ImageKind::Attachment => {
                        flush(&mut lines, &mut spans);
                        push_text(
                            &mut spans,
                            format!("{IMAGE_PLACEHOLDER}🖼 "),
                            Style::default().fg(YELLOW),
                        );
                    }
                }
            }
            Event::End(TagEnd::Image) => {
                // Slack proxies every emoji through slack-imgs.com and repeats
                // the same symbol as glyph, alt text and a doubly encoded URL.
                // The URL is never actionable, so it is dropped for both kinds;
                // attachments keep their own line because they are content.
                if let Some(entry) = images.last_mut() {
                    entry.alt = image_alt.trim().to_string();
                }
                swallow_shortcode = if graphics && image_kind == Some(ImageKind::Emoji) {
                    Some(format!(":{}:", image_alt.trim()))
                } else {
                    None
                };
                if image_kind.take() == Some(ImageKind::Attachment) {
                    flush(&mut lines, &mut spans);
                }
            }
            Event::Start(Tag::TableRow) => {
                flush(&mut lines, &mut spans);
                push_text(&mut spans, "│ ", Style::default().fg(MUTED));
            }
            Event::End(TagEnd::TableCell) => {
                push_text(&mut spans, " │ ", Style::default().fg(MUTED));
            }
            Event::Text(text) if image_kind.is_some() => {
                // Alt text belongs to the image record, not the line: for Slack
                // emoji the shortcode that follows in the source already
                // carries the symbol, and duplicating it would widen the line.
                image_alt.push_str(&text);
            }
            Event::Text(text) => {
                let text = match swallow_shortcode.take() {
                    Some(shortcode) => text
                        .strip_prefix(shortcode.as_str())
                        .map_or(text.clone(), |rest| rest.to_string().into()),
                    None => text,
                };
                let style = if in_code_block {
                    Style::default().fg(GREEN).bg(Color::Rgb(0x16, 0x17, 0x20))
                } else {
                    inline.last().copied().unwrap_or_default().style
                };
                let mut parts = text.split('\n').peekable();
                while let Some(part) = parts.next() {
                    push_text(&mut spans, part.to_string(), style);
                    if parts.peek().is_some() {
                        flush(&mut lines, &mut spans);
                    }
                }
            }
            Event::Code(code) => push_text(
                &mut spans,
                format!(" {code} "),
                Style::default().fg(GREEN).bg(Color::Rgb(0x22, 0x23, 0x2e)),
            ),
            Event::Rule => {
                flush(&mut lines, &mut spans);
                lines.push(Line::from(Span::styled(
                    "─".repeat(48),
                    Style::default().fg(MUTED),
                )));
            }
            Event::TaskListMarker(done) => push_text(
                &mut spans,
                if done { "☑ " } else { "☐ " },
                Style::default().fg(if done { GREEN } else { MUTED }),
            ),
            Event::FootnoteReference(label) => push_text(
                &mut spans,
                format!("[^{label}]"),
                Style::default().fg(ACCENT),
            ),
            _ => {}
        }
    }
    flush(&mut lines, &mut spans);
    while lines.last().is_some_and(|line| line.spans.is_empty()) {
        let _ = lines.pop();
    }
    (Text::from(lines), images)
}

/// How an image in Slack content should be treated.
///
/// Slack renders emoji as proxied images, so an image is not automatically
/// content. Unknown sources default to `Attachment`: an over-large image is
/// obvious and fixable, while an attachment collapsed to emoji size is lost.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageKind {
    /// Punctuation-sized emoji that must not disturb the line it sits in.
    Emoji,
    /// Real content deserving its own block.
    Attachment,
}

/// Classify an image URL as emoji or attachment.
#[must_use]
pub fn classify_image(url: &str) -> ImageKind {
    // Slack double-encodes the proxied target, so match on the decoded-ish text
    // rather than parsing: `%2F` separators keep the asset path recognisable.
    let lowered = url.to_lowercase();
    let emoji_asset = lowered.contains("production-standard-emoji-assets")
        || lowered.contains("production-standard-emoji")
        || lowered.contains("/emoji/");
    if lowered.contains("slack-imgs.com") && emoji_asset {
        return ImageKind::Emoji;
    }
    if emoji_asset {
        return ImageKind::Emoji;
    }
    ImageKind::Attachment
}

/// Collapse an emoji rendered twice in a row as alt text and shortcode.
///
/// Slack canvases emit `![calendar](proxied-url):calendar:`, so dropping the
/// URL alone would still leave the symbol twice.
#[must_use]
pub fn collapse_repeated_shortcodes(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find(':') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find(':') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let token = &after[..end];
        let is_shortcode = !token.is_empty()
            && token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '+');
        let shortcode = format!(":{token}:");
        rest = &after[end + 1..];
        if is_shortcode {
            out.push_str(&shortcode);
            while let Some(stripped) = rest.strip_prefix(shortcode.as_str()) {
                rest = stripped;
            }
        } else {
            out.push_str(&shortcode);
        }
    }
    out.push_str(rest);
    out
}

#[must_use]
pub fn extract_urls(source: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut rest = source;
    while let Some(index) = rest.find("http") {
        let candidate = &rest[index..];
        if candidate.starts_with("http://") || candidate.starts_with("https://") {
            let end = candidate
                .find(|character: char| {
                    character.is_whitespace() || matches!(character, ')' | '>' | '"' | '\'')
                })
                .unwrap_or(candidate.len());
            let url = candidate[..end].trim_end_matches(['.', ',', ';', ':']);
            if url.len() > 8 && !urls.iter().any(|existing| existing == url) {
                urls.push(url.to_string());
            }
            rest = &candidate[end..];
        } else {
            rest = &candidate[4..];
        }
    }
    urls
}

#[must_use]
pub fn preview(source: &str, max_chars: usize) -> String {
    let collapsed = source.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let mut value: String = collapsed
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect();
    value.push('…');
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered(source: &str) -> String {
        render_markdown(source)
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn markdown_preserves_headings_lists_code_and_links() {
        let text = rendered("# Title\n\n- one\n- **two**\n\n```rust\nfn main() {}\n```\n\n[site](https://example.com)");
        assert!(text.contains("Title"));
        assert!(text.contains("• one"));
        assert!(text.contains("• two"));
        assert!(text.contains("rust"));
        assert!(text.contains("fn main() {}"));
        assert!(text.contains("site ↗https://example.com"));
    }

    #[test]
    fn graphics_mode_swallows_the_duplicate_shortcode_after_an_emoji() {
        let source = "![calendar](https://slack-imgs.com/?url=production-standard-emoji-assets%2F1f4c6.png):calendar: Daily notes";
        let flatten = |text: Text<'static>| {
            text.lines
                .iter()
                .map(|line| {
                    line.spans
                        .iter()
                        .map(|span| span.content.as_ref())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n")
        };

        let with_graphics = flatten(render_markdown_for(source, true).0);
        assert!(
            !with_graphics.contains(":calendar:"),
            "the drawn image is the symbol; the shortcode would duplicate it: {with_graphics:?}"
        );
        assert!(with_graphics.contains("Daily notes"));
        assert_eq!(with_graphics.matches(IMAGE_PLACEHOLDER).count(), 1);

        let text_only = flatten(render_markdown_for(source, false).0);
        assert!(
            text_only.contains(":calendar:"),
            "without graphics the shortcode is the only representation: {text_only:?}"
        );
    }

    #[test]
    fn emoji_reserve_exactly_two_cells_and_preserve_the_sentence() {
        let source = "one ![calendar](https://slack-imgs.com/?url=production-standard-emoji-assets%2F1f4c6.png):calendar: two";
        let (text, images) = render_markdown_with_images(source);
        let rendered: String = text
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(images.len(), 1);
        assert_eq!(images[0].kind, ImageKind::Emoji);
        assert_eq!(images[0].alt, "calendar");
        assert!(images[0].url.contains("slack-imgs.com"));

        let placeholders = rendered.matches(IMAGE_PLACEHOLDER).count();
        assert_eq!(placeholders, 1, "one reservation per emoji: {rendered:?}");
        let reserved: String = rendered
            .chars()
            .skip_while(|c| *c != IMAGE_PLACEHOLDER)
            .take(2)
            .collect();
        assert_eq!(
            reserved.chars().count(),
            2,
            "an emoji occupies the two cells a unicode glyph would: {reserved:?}"
        );
        assert!(
            rendered.contains("one "),
            "text before survives: {rendered:?}"
        );
        assert!(
            rendered.contains(" two"),
            "text after survives: {rendered:?}"
        );
        assert!(!rendered.contains("slack-imgs.com"));
    }

    #[test]
    fn attachments_report_a_placement_and_keep_their_own_block() {
        let (text, images) = render_markdown_with_images(
            "before\n\n![diagram](https://files.slack.com/f/d.png)\n\nafter",
        );
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].kind, ImageKind::Attachment);
        assert_eq!(images[0].alt, "diagram");
        let lines: Vec<String> = text
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        assert!(
            lines
                .iter()
                .any(|line| line.contains(IMAGE_PLACEHOLDER) && !line.contains("before")),
            "attachment occupies its own line: {lines:?}"
        );
    }

    #[test]
    fn documents_without_images_report_no_placements() {
        let (_, images) = render_markdown_with_images("plain **text** only");
        assert!(images.is_empty());
    }

    #[test]
    fn slack_proxied_emoji_keeps_the_shortcode_and_drops_the_url() {
        let source = "![calendar](https://slack-imgs.com/?c=1&o1=gu&url=https%3A%2F%2Fa.slack-edge.com%2Fproduction-standard-emoji-assets%2F16.0%2Fapple-small%2F1f4c6%402x.png):calendar: Daily notes";
        let text = rendered(source);
        assert!(
            !text.contains("slack-imgs.com"),
            "proxied URL is dropped: {text}"
        );
        assert!(
            !text.contains("🖼"),
            "emoji are punctuation, not attachments: {text}"
        );
        assert_eq!(
            text.matches(":calendar:").count(),
            1,
            "the symbol appears once, not as alt plus shortcode: {text}"
        );
        assert!(
            text.contains("Daily notes"),
            "surrounding sentence survives: {text}"
        );
    }

    #[test]
    fn attachments_keep_a_marker_and_break_flow() {
        let text = rendered(
            "before ![架 diagram](https://files.slack.com/files-pri/T1-F2/diagram.png) after",
        );
        assert!(
            !text.contains("files.slack.com"),
            "raw URL is dropped: {text}"
        );
        assert!(
            text.contains("🖼"),
            "attachments stay marked as content: {text}"
        );
        let lines: Vec<&str> = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        assert!(
            lines
                .iter()
                .any(|line| line.contains("🖼") && !line.contains("before")),
            "attachment gets its own block: {lines:?}"
        );
    }

    #[test]
    fn image_classification_defaults_unknown_sources_to_attachment() {
        assert_eq!(
            classify_image("https://slack-imgs.com/?url=https%3A%2F%2Fa.slack-edge.com%2Fproduction-standard-emoji-assets%2F16.0%2F1f4c6.png"),
            ImageKind::Emoji
        );
        assert_eq!(
            classify_image("https://files.slack.com/files-pri/T1-F2/screenshot.png"),
            ImageKind::Attachment
        );
        assert_eq!(
            classify_image("https://example.com/unknown"),
            ImageKind::Attachment,
            "unknown sources must not be shrunk to emoji size"
        );
    }

    #[test]
    fn repeated_shortcodes_collapse_but_ordinary_colons_survive() {
        assert_eq!(
            collapse_repeated_shortcodes(":calendar::calendar: x"),
            ":calendar: x"
        );
        assert_eq!(collapse_repeated_shortcodes("ratio 3:4:5"), "ratio 3:4:5");
        assert_eq!(collapse_repeated_shortcodes("plain text"), "plain text");
        assert_eq!(collapse_repeated_shortcodes(":+1::+1: ok"), ":+1: ok");
    }

    #[test]
    fn urls_are_extracted_and_deduplicated() {
        let urls = extract_urls(
            "see https://example.com/a, and (http://x.test/b) plus https://example.com/a",
        );
        assert_eq!(urls, vec!["https://example.com/a", "http://x.test/b"]);
    }

    #[test]
    fn preview_collapses_and_bounds() {
        assert_eq!(preview("hello\n   world", 20), "hello world");
        assert_eq!(preview("one two three", 8), "one two…");
    }
}
