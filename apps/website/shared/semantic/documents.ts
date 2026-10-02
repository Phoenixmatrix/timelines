import type { Parser, SyntaxNode, Tree } from "@lezer/common";
import { parser as markdownParser } from "@lezer/markdown";
import { parser as xmlParser } from "@lezer/xml";
import { parser as jsonParser } from "@lezer/json";
import { parser as htmlParser } from "@lezer/html";
import { parser as cssParser } from "@lezer/css";
import type {
  LanguageAdapter,
  ParseDiagnostic,
  SemanticEntity,
  SemanticLanguage,
  SyntaxFact,
} from "./types.ts";

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

class Facts {
  readonly facts: SyntaxFact[] = [];
  private readonly occurrences = new Map<string, number>();
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
  text(node: SyntaxNode): string {
    return this.source.slice(node.from, node.to);
  }
  add(
    entity: SemanticEntity,
    name: string,
    scope: string,
    node: SyntaxNode,
    value: string,
    shape?: string,
  ): string {
    const base = `${scope}/${entity}:${name.length}:${name}`;
    const occurrence = this.occurrences.get(base) ?? 0;
    this.occurrences.set(base, occurrence + 1);
    const key = `${base}:${occurrence}`;
    this.facts.push({
      key,
      entity,
      name,
      scope,
      nodeType: node.name,
      from: node.from,
      to: node.to,
      value,
      ...(shape === undefined ? {} : { shape }),
    });
    return key;
  }
}

/** Leaves retain literal contents; skipped whitespace and comments are not syntax values. */
function tokens(node: SyntaxNode, facts: Facts): string {
  if (node.name === "Comment") return "";
  const nested = children(node);
  if (!nested.length) return JSON.stringify([node.name, facts.text(node)]);
  const parts: string[] = [];
  let offset = node.from;
  for (const child of nested) {
    const gap = facts.source.slice(offset, child.from).trim();
    if (gap) parts.push(gap);
    const value = tokens(child, facts);
    if (value) parts.push(value);
    offset = child.to;
  }
  const suffix = facts.source.slice(offset, node.to).trim();
  if (suffix) parts.push(suffix);
  return JSON.stringify([node.name, parts]);
}

function diagnostics(tree: Tree, language: SemanticLanguage): ParseDiagnostic[] {
  const result: ParseDiagnostic[] = [];
  tree.iterate({
    enter(node) {
      if (
        node.type.isError ||
        (language === "xml" && ["MissingCloseTag", "MismatchedCloseTag"].includes(node.name)) ||
        (language === "html" &&
          ["MismatchedCloseTag", "IncompleteTag", "IncompleteCloseTag"].includes(node.name))
      ) {
        result.push({
          message: `Invalid ${language} syntax (${node.name || "unexpected token"})`,
          from: node.from,
          to: node.to,
        });
      }
    },
  });
  return result;
}

function jsonFacts(root: SyntaxNode, facts: Facts): void {
  function visit(node: SyntaxNode, scope: string, name: string): void {
    if (node.name === "Object" || node.name === "Array") {
      const key = facts.add("property", name, scope, node, node.name);
      if (node.name === "Object") {
        for (const property of node.getChildren("Property")) {
          const propertyName = property.getChild("PropertyName");
          const value = children(property).find(
            (child) => !["PropertyName", ":"].includes(child.name),
          );
          if (propertyName && value)
            visit(value, key, JSON.parse(facts.text(propertyName)) as string);
        }
      } else {
        children(node)
          .filter((child) => !["[", "]", ","].includes(child.name))
          .forEach((child, index) => visit(child, key, `[${index}]`));
      }
    } else {
      const value =
        node.name === "String" ? JSON.stringify(JSON.parse(facts.text(node))) : facts.text(node);
      facts.add("property", name, scope, node, value, `${node.name}:${value}`);
    }
  }
  if (root.firstChild) visit(root.firstChild, "$", "$");
}

function markupFacts(root: SyntaxNode, facts: Facts, html: boolean): void {
  function visit(node: SyntaxNode, scope: string, preserve: boolean): void {
    if (node.name === "Comment") return;
    if (node.name === "Element") {
      const tag = node.getChild("OpenTag") ?? node.getChild("SelfClosingTag");
      const tagName = tag?.getChild("TagName");
      if (!tag || !tagName) return;
      const name = html ? facts.text(tagName).toLowerCase() : facts.text(tagName);
      const key = facts.add("element", name, scope, node, name);
      let keep = preserve || (html && ["pre", "textarea", "script", "style"].includes(name));
      for (const attribute of tag.getChildren("Attribute")) {
        const attributeName = attribute.getChild("AttributeName");
        if (!attributeName) continue;
        const attrName = html ? facts.text(attributeName).toLowerCase() : facts.text(attributeName);
        const valueNode =
          attribute.getChild("AttributeValue") ?? attribute.getChild("UnquotedAttributeValue");
        const value = valueNode
          ? valueNode.name === "AttributeValue"
            ? facts.text(valueNode).slice(1, -1)
            : facts.text(valueNode)
          : "<boolean>";
        facts.add("attribute", attrName, key, attribute, value);
        if (attrName === "xml:space") keep = value === "preserve";
      }
      for (const child of children(node))
        if (child !== tag && !["OpenTag", "SelfClosingTag", "CloseTag"].includes(child.name))
          visit(child, key, keep);
      return;
    }
    if (
      [
        "Text",
        "Cdata",
        "EntityReference",
        "CharacterReference",
        "ScriptText",
        "StyleText",
        "TextareaText",
      ].includes(node.name)
    ) {
      const raw = facts.text(node);
      if (!preserve && !raw.trim() && /[\r\n]/.test(raw)) return;
      // XML and preformatted HTML whitespace is data. Ordinary HTML collapses runs, not word boundaries.
      const value = html && !preserve ? raw.replace(/\s+/g, " ") : raw;
      facts.add("text", "text", scope, node, value);
      return;
    }
    if (["DoctypeDecl", "ProcessingInst"].includes(node.name)) {
      facts.add("declaration", node.name, scope, node, facts.text(node));
      return;
    }
    for (const child of children(node)) visit(child, scope, preserve);
  }
  visit(root, "$", false);
}

function cssFacts(root: SyntaxNode, facts: Facts): void {
  function visit(node: SyntaxNode, scope: string): void {
    if (node.name === "Comment") return;
    if (node.name === "Declaration") {
      const nameNode = node.getChild("PropertyName") ?? node.getChild("VariableName");
      if (!nameNode) return;
      const value = JSON.stringify(
        children(node)
          .filter((child) => child.from >= nameNode.to && child.name !== ":")
          .map((child) => tokens(child, facts))
          .filter(Boolean),
      );
      facts.add("declaration", facts.text(nameNode), scope, node, value);
      return;
    }
    if (node.name === "RuleSet" || node.name === "AtRule" || node.name.endsWith("Statement")) {
      const block = node.getChild("Block") ?? node.getChild("KeyframeList");
      const header = children(node).filter(
        (child) =>
          child.name !== "Comment" && child.name !== ";" && (!block || child.to <= block.from),
      );
      const value = JSON.stringify(header.map((child) => tokens(child, facts)));
      const name =
        node.name === "RuleSet"
          ? header.map((child) => selectorName(child, facts)).join("")
          : header[0]
            ? facts.text(header[0])
            : node.name;
      const key = facts.add("rule", name, scope, node, value);
      if (block) visit(block, key);
      return;
    }
    if (node.name === "KeyframeList") {
      let selectors: SyntaxNode[] = [];
      for (const child of children(node)) {
        if (child.name === "KeyframeSelector") selectors.push(child);
        if (child.name === "Block") {
          const name = selectors.map((selector) => facts.text(selector)).join(",");
          const key = facts.add("rule", name, scope, child, name);
          visit(child, key);
          selectors = [];
        }
      }
      return;
    }
    for (const child of children(node)) visit(child, scope);
  }
  visit(root, "$");
}

function selectorName(node: SyntaxNode, facts: Facts): string {
  if (node.name === "Comment") return "";
  const nested = children(node);
  if (!nested.length) return facts.text(node);
  const parts: string[] = [];
  let offset = node.from;
  for (const child of nested) {
    const gap = facts.source.slice(offset, child.from).trim();
    if (gap) parts.push(gap);
    const value = selectorName(child, facts);
    if (value) parts.push(value);
    offset = child.to;
  }
  const suffix = facts.source.slice(offset, node.to).trim();
  if (suffix) parts.push(suffix);
  // Descendant whitespace is an operator, unlike whitespace surrounding >, +, and ~.
  return parts.join(node.name === "DescendantSelector" ? " " : "");
}

function markdownFacts(root: SyntaxNode, facts: Facts): void {
  function inline(node: SyntaxNode): string {
    if (["Comment", "CommentBlock"].includes(node.name)) return "";
    if (["Link", "Image"].includes(node.name)) return linkLabel(node);
    if (["InlineCode", "CodeText", "HardBreak", "HTMLTag"].includes(node.name))
      return facts.text(node);
    let value = "",
      offset = node.from;
    for (const child of children(node)) {
      value += facts.source.slice(offset, child.from).replace(/\r?\n/g, " ");
      if (!["HeaderMark", "CodeMark"].includes(child.name)) value += inline(child);
      offset = child.to;
    }
    return value + facts.source.slice(offset, node.to).replace(/\r?\n/g, " ");
  }
  function linkLabel(node: SyntaxNode): string {
    const marks = node.getChildren("LinkMark");
    const opening = marks.find((mark) => facts.text(mark).endsWith("["));
    const closing = marks.find((mark) => facts.text(mark) === "]");
    return opening && closing ? facts.source.slice(opening.to, closing.from) : facts.text(node);
  }
  function links(node: SyntaxNode, scope: string): void {
    if (["Link", "Image", "Autolink", "LinkReference"].includes(node.name)) {
      const name =
        node.name === "LinkReference"
          ? facts.text(node.getChild("LinkLabel") ?? node)
          : linkLabel(node);
      const parts = children(node).filter((child) =>
        ["URL", "LinkTitle", "LinkLabel"].includes(child.name),
      );
      const value = parts.length
        ? JSON.stringify(parts.map((part) => [part.name, facts.text(part)]))
        : facts.text(node);
      facts.add("link", name, scope, node, value);
      return;
    }
    for (const child of children(node)) links(child, scope);
  }
  function blocks(node: SyntaxNode, initialScope: string): void {
    const sections: { level: number; key: string }[] = [];
    for (const child of children(node)) {
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(child.name);
      if (heading) {
        const level = Number(heading[1]);
        while (sections.length && sections[sections.length - 1]!.level >= level) sections.pop();
        const scope = sections[sections.length - 1]?.key ?? initialScope;
        const name = inline(child).trim();
        const key = facts.add("section", name, scope, child, String(level));
        sections.push({ level, key });
        links(child, key);
        continue;
      }
      const scope = sections[sections.length - 1]?.key ?? initialScope;
      if (["Comment", "CommentBlock"].includes(child.name)) continue;
      if (["BulletList", "OrderedList", "ListItem", "Blockquote"].includes(child.name)) {
        const key = facts.add("section", child.name, scope, child, child.name);
        blocks(child, key);
      } else if (child.name === "LinkReference") {
        links(child, scope);
      } else if (["FencedCode", "CodeBlock"].includes(child.name)) {
        const code = child
          .getChildren("CodeText")
          .map((part) => facts.text(part))
          .join("\n");
        const info = child.getChild("CodeInfo");
        facts.add(
          "text",
          "code",
          scope,
          child,
          JSON.stringify([info ? facts.text(info) : "", code]),
        );
      } else if (!["ListMark", "QuoteMark"].includes(child.name)) {
        facts.add("text", "content", scope, child, inline(child).trim());
        links(child, scope);
      }
    }
  }
  blocks(root, "$");
}

function adapter(
  language: SemanticLanguage,
  extensions: readonly string[],
  parser: Parser,
  extract: (root: SyntaxNode, facts: Facts) => void,
): LanguageAdapter {
  return {
    language,
    extensions,
    parse(source) {
      const tree = parser.parse(source);
      const errors = diagnostics(tree, language);
      const facts = new Facts(source);
      if (!errors.length) extract(tree.topNode, facts);
      return { language, tree, diagnostics: errors, facts: facts.facts };
    },
  };
}

export const documentAdapters: LanguageAdapter[] = [
  adapter("markdown", [".md", ".markdown", ".mdown"], markdownParser, markdownFacts),
  adapter("xml", [".xml", ".svg", ".xsl", ".xslt", ".xsd"], xmlParser, (root, facts) =>
    markupFacts(root, facts, false),
  ),
  adapter("json", [".json"], jsonParser, jsonFacts),
  adapter("html", [".html", ".htm"], htmlParser, (root, facts) => markupFacts(root, facts, true)),
  adapter("css", [".css"], cssParser, cssFacts),
];
