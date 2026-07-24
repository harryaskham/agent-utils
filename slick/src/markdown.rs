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
        lines.push(Line::from(std::mem::take(spans)));
    }
}

#[must_use]
pub fn render_markdown(source: &str) -> Text<'static> {
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
            Event::Start(Tag::Paragraph) => {
                if quote_depth > 0 && spans.is_empty() {
                    push_text(
                        &mut spans,
                        "▌ ".repeat(quote_depth),
                        Style::default().fg(ACCENT),
                    );
                }
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
                link_target = Some(dest_url.to_string());
                push_text(&mut spans, "🖼 ", Style::default().fg(YELLOW));
            }
            Event::End(TagEnd::Image) => {
                if let Some(target) = link_target.take() {
                    push_text(
                        &mut spans,
                        format!(" ({target})"),
                        Style::default().fg(MUTED),
                    );
                }
            }
            Event::Start(Tag::TableRow) => {
                flush(&mut lines, &mut spans);
                push_text(&mut spans, "│ ", Style::default().fg(MUTED));
            }
            Event::End(TagEnd::TableCell) => {
                push_text(&mut spans, " │ ", Style::default().fg(MUTED));
            }
            Event::Text(text) => {
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
                    "─".repeat(72),
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
    Text::from(lines)
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
    fn preview_collapses_and_bounds() {
        assert_eq!(preview("hello\n   world", 20), "hello world");
        assert_eq!(preview("one two three", 8), "one two…");
    }
}
