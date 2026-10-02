import type { Parser, SyntaxNode } from "@lezer/common";
import { parser as javascript } from "@lezer/javascript";
import { parser as rust } from "@lezer/rust";
import { parser as python } from "@lezer/python";
import { parser as go } from "@lezer/go";
import type { LanguageAdapter, SemanticEntity, SemanticLanguage, SyntaxFact } from "./types.ts";

const comments: Record<string, true> = {
  LineComment: true,
  BlockComment: true,
  Comment: true,
  Hashbang: true,
};
const literals: Record<string, true> = {
  String: true,
  RawString: true,
  Char: true,
  Rune: true,
  RegExp: true,
  TemplateString: true,
  FormatString: true,
  JSXText: true,
};
const bodies: Record<string, true> = {
  Block: true,
  Body: true,
  ClassBody: true,
  ObjectType: true,
  DeclarationList: true,
  FieldDeclarationList: true,
  OrderedFieldDeclarationList: true,
  EnumBody: true,
  EnumVariantList: true,
  StructBody: true,
  InterfaceBody: true,
};
const declarations: Record<string, true> = {
  FunctionDeclaration: true,
  AmbientFunctionDeclaration: true,
  ClassDeclaration: true,
  MethodDeclaration: true,
  PropertyDeclaration: true,
  TypeAliasDeclaration: true,
  InterfaceDeclaration: true,
  EnumDeclaration: true,
  NamespaceDeclaration: true,
  MethodType: true,
  PropertyType: true,
  FunctionItem: true,
  StructItem: true,
  UnionItem: true,
  EnumItem: true,
  TypeItem: true,
  TraitItem: true,
  AssociatedType: true,
  ConstItem: true,
  StaticItem: true,
  ModItem: true,
  MacroDefinition: true,
  EnumVariant: true,
  FieldDeclaration: true,
  FunctionDefinition: true,
  ClassDefinition: true,
  TypeDefinition: true,
  FunctionDecl: true,
  MethodDecl: true,
  TypeSpec: true,
  FieldDecl: true,
  MethodElem: true,
};
const declarationNames: Record<string, true> = {
  VariableDefinition: true,
  TypeDefinition: true,
  PropertyDefinition: true,
  PrivatePropertyDefinition: true,
  BoundIdentifier: true,
  TypeIdentifier: true,
  Identifier: true,
  FieldIdentifier: true,
  VariableName: true,
  DefName: true,
  FieldName: true,
};
const imports: Record<string, true> = {
  ImportDeclaration: true,
  UseDeclaration: true,
  ExternCrateDeclaration: true,
  ImportStatement: true,
  ImportSpec: true,
};
const calls: Record<string, true> = {
  CallExpression: true,
  NewExpression: true,
  CallExpr: true,
  StructExpression: true,
  TypedLiteral: true,
  MacroInvocation: true,
  MacroInvocationSemi: true,
};
const argumentLists: Record<string, true> = {
  ArgList: true,
  Arguments: true,
  FieldInitializerList: true,
  LiteralValue: true,
  ParenthesizedTokens: true,
  BracketedTokens: true,
  BracedTokens: true,
};

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

/** Only grammar tokens are normalized; literal contents are never whitespace-stripped. */
function normalized(
  source: string,
  nodes: readonly SyntaxNode[],
  language: SemanticLanguage,
  mask?: SyntaxNode,
): string {
  const tokens: string[] = [];
  function visit(node: SyntaxNode) {
    if (comments[node.name] || node.from === node.to) return;
    if (mask && node.from === mask.from && node.to === mask.to) {
      tokens.push(`${node.name}:<name>`);
    } else if (["TemplateString", "FormatString", "FormatSpec"].includes(node.name)) {
      let offset = node.from;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.from > offset) tokens.push(`literal:${source.slice(offset, child.from)}`);
        visit(child);
        offset = child.to;
      }
      if (offset < node.to) tokens.push(`literal:${source.slice(offset, node.to)}`);
    } else if (literals[node.name] || !node.firstChild) {
      // Rust's trailing semicolon changes a block's value; JS/Go terminators may be inserted.
      if (node.name !== ";" || language === "rust" || node.parent?.name === "ForSpec")
        tokens.push(`${node.name}:${source.slice(node.from, node.to)}`);
    } else {
      // Keep tree structure: `return\\nf()` must differ from `return f()`.
      tokens.push(`${node.name}[`);
      for (let child: SyntaxNode | null = node.firstChild; child; child = child.nextSibling)
        visit(child);
      tokens.push("]");
    }
  }
  nodes.forEach(visit);
  return JSON.stringify(tokens);
}

function syntaxName(source: string, node: SyntaxNode): string {
  if (comments[node.name]) return "";
  if (literals[node.name] || !node.firstChild) return source.slice(node.from, node.to);
  return children(node)
    .map((child) => syntaxName(source, child))
    .join("");
}

function groups(nodes: readonly SyntaxNode[]): SyntaxNode[][] {
  const result: SyntaxNode[][] = [];
  let current: SyntaxNode[] = [];
  for (const node of nodes) {
    if (comments[node.name] || ["(", ")", "{", "}", "[", "]", ";", "|"].includes(node.name))
      continue;
    if (node.name === ",") {
      if (current.length) result.push(current);
      current = [];
    } else current.push(node);
  }
  if (current.length) result.push(current);
  return result;
}

function adapter(
  language: SemanticLanguage,
  extensions: readonly string[],
  parser: Parser,
): LanguageAdapter {
  return {
    language,
    extensions,
    parse(source) {
      const tree = parser.parse(source);
      const facts: SyntaxFact[] = [];
      const diagnostics: { message: string; from: number; to: number }[] = [];
      const occurrences = new Map<string, number>();
      tree.iterate({
        enter(node) {
          if (node.type.isError)
            diagnostics.push({
              message: `Invalid ${language} syntax`,
              from: node.from,
              to: node.to,
            });
          // The Go grammar deliberately accepts missing closing quotes on interpreted literals.
          if (language === "go" && (node.name === "String" || node.name === "Rune")) {
            const text = source.slice(node.from, node.to);
            let escapes = 0;
            for (let i = text.length - 2; i >= 0 && text[i] === "\\"; i--) escapes++;
            if (
              text.length < 2 ||
              text.at(-1) !== text[0] ||
              (text[0] !== "`" && escapes % 2 !== 0)
            ) {
              diagnostics.push({
                message: "Unterminated Go literal",
                from: node.from,
                to: node.to,
              });
            }
          }
        },
      });

      function emit(
        entity: SemanticEntity,
        name: string,
        scope: string,
        nodes: readonly SyntaxNode[],
        identity = name,
        mask?: SyntaxNode,
        header?: readonly SyntaxNode[],
      ) {
        const first = nodes[0];
        const last = nodes.at(-1);
        if (!first || !last) return "";
        const base = JSON.stringify([scope, entity, identity]);
        const occurrence = occurrences.get(base) ?? 0;
        occurrences.set(base, occurrence + 1);
        const key = `${base}#${occurrence}`;
        facts.push({
          key,
          entity,
          name,
          scope,
          nodeType: first.name,
          from: first.from,
          to: last.to,
          value: normalized(source, nodes, language),
          ...(mask ? { shape: normalized(source, nodes, language, mask) } : {}),
          ...(header ? { signature: normalized(source, header, language) } : {}),
        });
        return occurrence ? `${name}#${occurrence + 1}` : name;
      }
      function bindingNodes(node: SyntaxNode, nameType: string): SyntaxNode[] {
        if (node.name === nameType) return [node];
        // Do not treat identifiers in defaults, computed keys, member access or types as bindings.
        if (
          ![
            "ArrayPattern",
            "ObjectPattern",
            "PatternProperty",
            "TuplePattern",
            "SlicePattern",
            "StructPattern",
            "FieldPatternList",
            "FieldPattern",
            "TupleExpression",
            "ArrayExpression",
            "TupleStructPattern",
            "ReferencePattern",
            "CapturedPattern",
          ].includes(node.name)
        )
          return [];
        const result: SyntaxNode[] = [];
        for (const child of children(node)) {
          if (
            ["Equals", "AssignOp", "="].includes(child.name) ||
            (child.name === ":" && node.name !== "PatternProperty" && node.name !== "FieldPattern")
          )
            break;
          result.push(...bindingNodes(child, nameType));
        }
        return result;
      }
      function walk(node: SyntaxNode, scope: string) {
        if (comments[node.name]) return;
        const parts = children(node);
        let childScope = scope;
        if (declarations[node.name]) {
          const nameNode = parts.find((child) => declarationNames[child.name]);
          if (nameNode) {
            const name = source.slice(nameNode.from, nameNode.to);
            let bodyIndex = parts.findIndex(
              (child) => bodies[child.name] || ["Equals", "="].includes(child.name),
            );
            // TypeSpec's body is nested beneath StructType/InterfaceType, but its full type is its signature.
            if (bodyIndex < 0) bodyIndex = parts.length;
            let valueNode = node;
            const prefix: SyntaxNode[] = [];
            while (
              valueNode.parent &&
              [
                "ExportDeclaration",
                "AmbientDeclaration",
                "DecoratedStatement",
                "AttributeItem",
              ].includes(valueNode.parent.name)
            ) {
              const wrapper = valueNode.parent;
              prefix.unshift(...children(wrapper).filter((child) => child.to <= valueNode.from));
              valueNode = wrapper;
            }
            let declarationScope = scope;
            if (node.name === "MethodDecl") {
              const receiver = parts
                .find((child) => child.name === "Parameters")
                ?.getChild("Parameter");
              const receiverType =
                receiver && children(receiver).find((child) => child.name !== "DefName");
              if (receiverType)
                declarationScope = scope
                  ? `${scope}.${syntaxName(source, receiverType)}`
                  : syntaxName(source, receiverType);
            }
            const owner = emit("symbol", name, declarationScope, [valueNode], name, nameNode, [
              ...prefix,
              ...parts.slice(0, bodyIndex),
            ]);
            childScope = declarationScope ? `${declarationScope}.${owner}` : owner;
          }
        } else if (node.name === "ImplItem") {
          const header = parts.slice(
            0,
            parts.findIndex((child) => child.name === "DeclarationList"),
          );
          const name = `impl ${header
            .slice(1)
            .map((child) => syntaxName(source, child))
            .join(" ")}`;
          const owner = emit("symbol", name, scope, [node], name, undefined, header);
          childScope = scope ? `${scope}.${owner}` : owner;
        } else if (imports[node.name]) {
          const name = parts
            .filter(
              (child) =>
                !["import", "use", "extern", "crate", ";"].includes(child.name) &&
                !comments[child.name],
            )
            .map((child) => syntaxName(source, child))
            .join(" ");
          emit("import", name, scope, [node]);
        } else if (
          [
            "VariableDeclaration",
            "LetDeclaration",
            "VarSpec",
            "ConstSpec",
            "VarDecl",
            "AssignStatement",
          ].includes(node.name)
        ) {
          // Grouped Go declarations are containers; the individual specs own their facts.
          if (!parts.some((child) => ["VarSpec", "ConstSpec"].includes(child.name))) {
            const segments = node.name === "VariableDeclaration" ? groups(parts) : [parts];
            for (const segment of segments) {
              const nameType =
                language === "python"
                  ? "VariableName"
                  : language === "rust"
                    ? "BoundIdentifier"
                    : language === "go"
                      ? "DefName"
                      : "VariableDefinition";
              const bindings: SyntaxNode[] = [];
              for (const child of segment) {
                if (
                  ["Equals", "AssignOp", "=", ":=", "TypeAnnotation", "TypeDef"].includes(
                    child.name,
                  )
                )
                  break;
                bindings.push(...bindingNodes(child, nameType));
              }
              const prefix =
                node.parent?.name === "ExportDeclaration"
                  ? children(node.parent).filter((child) => child.to <= node.from)
                  : [];
              const value = [...prefix, ...segment];
              const initializer = value.findIndex((child) =>
                ["Equals", "AssignOp", "=", ":="].includes(child.name),
              );
              for (const binding of bindings)
                emit(
                  "symbol",
                  source.slice(binding.from, binding.to),
                  scope,
                  value,
                  source.slice(binding.from, binding.to),
                  bindings.length === 1 ? binding : undefined,
                  value.slice(0, initializer < 0 ? value.length : initializer),
                );
            }
          }
        }
        if (["ParamList", "Parameters", "TypeParamList", "TypeParams"].includes(node.name)) {
          for (const [index, group] of groups(parts).entries()) {
            const wrapped =
              group.length === 1 &&
              [
                "Parameter",
                "SelfParameter",
                "TypeParam",
                "ConstParameter",
                "ConstrainedTypeParameter",
                "OptionalTypeParameter",
              ].includes(group[0]!.name)
                ? children(group[0]!)
                : group;
            const names = wrapped.filter((child) =>
              [
                "VariableDefinition",
                "VariableName",
                "BoundIdentifier",
                "DefName",
                "TypeIdentifier",
                "TypeName",
                "self",
                "Lifetime",
              ].includes(child.name),
            );
            const nameNode = names[0];
            const name = nameNode
              ? source.slice(nameNode.from, nameNode.to)
              : `parameter ${index + 1}`;
            emit("parameter", name, scope, group, `${node.name}:${index}`);
          }
        }
        if (calls[node.name]) {
          const list = parts.find((child) => argumentLists[child.name]);
          const callee = parts.find(
            (child) =>
              !(node.name === "NewExpression" && child.name === "new") &&
              !argumentLists[child.name] &&
              !comments[child.name],
          );
          if (callee) {
            const name = `${node.name === "NewExpression" ? "new " : ""}${syntaxName(source, callee)}`;
            const owner = emit("call", name, scope, [node], normalized(source, [callee], language));
            const callScope = scope ? `${scope}.${owner}` : owner;
            if (list)
              for (const [index, group] of groups(children(list)).entries())
                emit("argument", `${name} argument ${index + 1}`, callScope, group, String(index));
          }
        }
        // Top-level executable statements also need evidence when no enclosing symbol owns a body.
        if (
          !scope &&
          [
            "ExpressionStatement",
            "ExprStatement",
            "IfStatement",
            "ForStatement",
            "WhileStatement",
            "TryStatement",
            "WithStatement",
            "MatchStatement",
            "Assignment",
            "UpdateStatement",
          ].includes(node.name)
        ) {
          emit("declaration", node.name, scope, [node]);
        }
        // Anonymous functions get an occurrence-scoped owner, so their parameters do not collide.
        if (
          [
            "ArrowFunction",
            "FunctionExpression",
            "LambdaExpression",
            "FunctionLiteral",
            "ClosureExpression",
          ].includes(node.name)
        ) {
          const owner = emit("symbol", "<anonymous>", scope, [node], node.name);
          childScope = scope ? `${scope}.${owner}` : owner;
        }
        for (const child of parts) walk(child, childScope);
      }
      walk(tree.topNode, "");
      return { language, tree, facts, diagnostics };
    },
  };
}

export const programmingAdapters: LanguageAdapter[] = [
  adapter("typescript", [".ts", ".mts", ".cts"], javascript.configure({ dialect: "ts" })),
  adapter("tsx", [".tsx"], javascript.configure({ dialect: "ts jsx" })),
  adapter("rust", [".rs"], rust),
  adapter("python", [".py", ".pyi"], python),
  adapter("go", [".go"], go),
];
