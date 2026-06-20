import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import ts from "typescript";
import type { SymbolDef, JsDocInfo, ParamInfo, CallInfo, ImportInfo } from "../data/models";

/**
 * SymbolExtractor — enhanced TypeScript/JavaScript AST-based symbol extraction
 * for codebase indexing.
 *
 * Parses TypeScript/JavaScript files to extract rich metadata:
 *   - Top-level declarations (functions, classes, variables, etc.)
 *   - JSDoc documentation (description, @param, @returns, custom tags)
 *   - Function signatures (parameters with names and types, return types)
 *   - Import declarations (module specifiers and bindings)
 *   - Internal call expressions (which functions call what)
 *
 * This is a separate class from SymbolResolver. SymbolResolver focuses on
 * lightweight symbol detection for locking granularity; SymbolExtractor
 * does deep extraction for the codebase index.
 */
export class SymbolExtractor {
  private static readonly TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
  private static readonly JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

  /**
   * Extract enhanced symbols and imports from a file.
   * Returns null for non-TS/JS files, empty files, or parse failures.
   */
  extract(filePath: string): { symbols: SymbolDef[]; imports: ImportInfo[] } | null {
    if (!fs.existsSync(filePath)) return null;

    const ext = path.extname(filePath).toLowerCase();
    if (!SymbolExtractor.TS_EXTS.has(ext) && !SymbolExtractor.JS_EXTS.has(ext)) {
      return null;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }

    if (content.trim().length === 0) return null;

    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    } catch {
      return null;
    }

    const symbols: SymbolDef[] = [];
    const imports: ImportInfo[] = [];
    // Collect class method names for later filtering in calls
    const methodNames = new Set<string>();

    const getLine = (pos: number) =>
      sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

    const visit = (node: ts.Node): void => {
      // --- Import declaration ---
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
        const named: string[] = [];
        let defaultImport: string | null = null;
        let namespaceImport: string | null = null;

        if (node.importClause) {
          if (node.importClause.name) {
            defaultImport = node.importClause.name.text;
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              namespaceImport = node.importClause.namedBindings.name.text;
            } else if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const el of node.importClause.namedBindings.elements) {
                named.push(el.name.text);
              }
            }
          }
        }
        imports.push({ moduleSpecifier, namedImports: named, defaultImport, namespaceImport });
        return;
      }

      // --- Function declaration ---
      if (ts.isFunctionDeclaration(node)) {
        if (node.name) {
          symbols.push({
            name: node.name.text,
            kind: "function",
            range: [getLine(node.getStart()), getLine(node.getEnd())],
            exported: SymbolExtractor.hasExportModifier(node),
            jsDoc: SymbolExtractor.extractJsDoc(node, sourceFile),
            parameters: SymbolExtractor.extractParameters(node, sourceFile),
            returnType: SymbolExtractor.extractReturnType(node, sourceFile),
            calls: node.body ? SymbolExtractor.collectCalls(node.body, sourceFile, methodNames) : [],
          });
        }
        return; // don't recurse into function body (calls already collected separately)
      }

      // --- Class declaration ---
      if (ts.isClassDeclaration(node)) {
        // Collect methods from class body
        const classMethods: SymbolDef[] = [];
        if (node.members) {
          for (const member of node.members) {
            if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
              const isConstructor = ts.isConstructorDeclaration(member);
              const methodName = isConstructor
                ? "constructor"
                : member.name && ts.isIdentifier(member.name)
                  ? member.name.text
                  : member.name?.getText(sourceFile) ?? "(anonymous)";
              methodNames.add(methodName);

              classMethods.push({
                name: methodName,
                kind: "function",
                range: [getLine(member.getStart()), getLine(member.getEnd())],
                exported: SymbolExtractor.hasExportModifier(member),
                jsDoc: SymbolExtractor.extractJsDoc(member, sourceFile),
                parameters: SymbolExtractor.extractParameters(member, sourceFile),
                returnType: SymbolExtractor.extractReturnType(member, sourceFile),
                calls: member.body
                  ? SymbolExtractor.collectCalls(member.body, sourceFile, methodNames)
                  : [],
              });
            }
          }
        }

        // Class calls: walk all method bodies to collect intra-class calls
        const allClassCalls: CallInfo[] = [];
        if (node.members) {
          for (const member of node.members) {
            if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body) {
              allClassCalls.push(...SymbolExtractor.collectCalls(member.body, sourceFile, methodNames));
            }
          }
        }

        symbols.push({
          name: node.name?.text ?? "(anonymous)",
          kind: "class",
          range: [getLine(node.getStart()), getLine(node.getEnd())],
          exported: SymbolExtractor.hasExportModifier(node),
          jsDoc: SymbolExtractor.extractJsDoc(node, sourceFile),
          calls: allClassCalls.slice(0, 50), // cap class call list
        });

        // Push method symbols too
        symbols.push(...classMethods);

        return; // don't recurse into class body
      }

      // --- Variable statement (const / let / var) ---
      if (ts.isVariableStatement(node)) {
        const isExported = SymbolExtractor.hasExportModifier(node);
        const flags = node.declarationList.flags;
        const varKind: SymbolDef["kind"] = (flags & ts.NodeFlags.Const) !== 0
          ? "const" : (flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";

        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const sym: SymbolDef = {
              name: decl.name.text,
              kind: varKind,
              range: [getLine(decl.getStart()), getLine(decl.getEnd())],
              exported: isExported,
              jsDoc: SymbolExtractor.extractJsDoc(node, sourceFile),
            };

            // Arrow function or function expression assigned to variable
            if (decl.initializer && ts.isFunctionLike(decl.initializer)) {
              sym.parameters = SymbolExtractor.extractParameters(decl.initializer, sourceFile);
              sym.returnType = SymbolExtractor.extractReturnType(decl.initializer, sourceFile);
              sym.calls = (decl.initializer as ts.FunctionLikeDeclaration).body
                ? SymbolExtractor.collectCalls(
                    (decl.initializer as ts.FunctionLikeDeclaration).body!,
                    sourceFile,
                    methodNames
                  )
                : [];
              sym.kind = "function";
            }

            symbols.push(sym);
          }
        }
        return;
      }

      // --- Interface declaration ---
      if (ts.isInterfaceDeclaration(node)) {
        symbols.push({
          name: node.name.text,
          kind: "interface",
          range: [getLine(node.getStart()), getLine(node.getEnd())],
          exported: SymbolExtractor.hasExportModifier(node),
          jsDoc: SymbolExtractor.extractJsDoc(node, sourceFile),
        });
        return;
      }

      // --- Type alias ---
      if (ts.isTypeAliasDeclaration(node)) {
        symbols.push({
          name: node.name.text,
          kind: "type",
          range: [getLine(node.getStart()), getLine(node.getEnd())],
          exported: SymbolExtractor.hasExportModifier(node),
          jsDoc: SymbolExtractor.extractJsDoc(node, sourceFile),
        });
        return;
      }

      // --- Export assignment (export default ...) ---
      if (ts.isExportAssignment(node)) {
        symbols.push({
          name: "default",
          kind: "export",
          range: [getLine(node.getStart()), getLine(node.getEnd())],
          exported: true,
        });
        return;
      }

      // --- Export declaration (export { ... }) ---
      if (ts.isExportDeclaration(node)) {
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const spec of node.exportClause.elements) {
            symbols.push({
              name: spec.name.text,
              kind: "export",
              range: [getLine(spec.getStart()), getLine(spec.getEnd())],
              exported: true,
            });
          }
        }
        return;
      }

      // Recurse into child nodes (but not into function/class bodies)
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return { symbols, imports };
  }

  /**
   * Compute a SHA-256 hash of file contents (first 16 hex chars).
   */
  static hashFile(filePath: string): string {
    try {
      const content = fs.readFileSync(filePath);
      return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    } catch {
      return "hash-error";
    }
  }

  // ---- JSDoc extraction ----

  private static extractJsDoc(node: ts.Node, sourceFile: ts.SourceFile): JsDocInfo | undefined {
    let description = "";
    const tags: { name: string; text: string }[] = [];
    const params: { name: string; text: string }[] = [];
    let returns = "";

    try {
      // Use the getJSDoc APIs (stable in TS 5.4.x)
      const jsDocNodes = ts.getJSDocCommentsAndTags(node);

      for (const entry of jsDocNodes) {
        // entry is JSDoc | JSDocTag — only JSDoc has comment and nested tags
        if ("comment" in entry) {
          // This is a JSDoc node
          const jsdoc = entry as ts.JSDoc;
          if (jsdoc.comment && typeof jsdoc.comment === "string") {
            const trimmed = jsdoc.comment.trim();
            if (trimmed) {
              description = (description ? description + " " : "") + trimmed;
            }
          }

          if (jsdoc.tags) {
            for (const tag of jsdoc.tags) {
              const tagName = tag.tagName.text.toLowerCase();
              const tagText = typeof tag.comment === "string" ? tag.comment.trim() : "";

              if (tag.kind === ts.SyntaxKind.JSDocParameterTag) {
                const paramTag = tag as ts.JSDocParameterTag;
                const paramName = ts.isIdentifier(paramTag.name)
                  ? paramTag.name.text
                  : "?";
                params.push({ name: paramName, text: tagText });
              } else if (tag.kind === ts.SyntaxKind.JSDocReturnTag) {
                returns = tagText;
              } else if (tagText) {
                tags.push({ name: tagName, text: tagText });
              }
            }
          }
        }
      }
    } catch {
      // JSDoc API may change in future TS versions — silently fail
    }

    // Only return if we actually found something
    if (description || tags.length > 0 || params.length > 0 || returns) {
      return { description, tags, params, returns };
    }
    return undefined;
  }

  // ---- Parameter extraction ----

  private static extractParameters(
    node: ts.FunctionLikeDeclaration,
    sourceFile: ts.SourceFile
  ): ParamInfo[] {
    const params: ParamInfo[] = [];
    try {
      for (const param of node.parameters) {
        const name = ts.isIdentifier(param.name) ? param.name.text : "<destructured>";
        const type = param.type ? param.type.getText(sourceFile) : "any";
        const optional = param.questionToken !== undefined;
        const isRest = param.dotDotDotToken !== undefined;
        const defaultValue = param.initializer ? param.initializer.getText(sourceFile) : undefined;

        params.push({ name, type, optional, isRest, defaultValue });
      }
    } catch {
      // Silently fail on malformed params
    }
    return params;
  }

  // ---- Return type extraction ----

  private static extractReturnType(
    node: ts.FunctionLikeDeclaration | ts.ArrowFunction,
    sourceFile: ts.SourceFile
  ): string | undefined {
    try {
      if (node.type) {
        return node.type.getText(sourceFile);
      }
    } catch {
      // Silently fail
    }
    return undefined;
  }

  // ---- Call collection ----

  private static collectCalls(
    body: ts.Node,
    sourceFile: ts.SourceFile,
    methodNames?: Set<string>
  ): CallInfo[] {
    const calls: CallInfo[] = [];
    const seen = new Set<string>(); // dedup by name+line

    const walkCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        let callName: string | null = null;

        if (ts.isIdentifier(node.expression)) {
          callName = node.expression.text;
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.name)
        ) {
          callName = node.expression.name.text;
        }

        if (callName) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const key = `${callName}:${line}`;
          if (!seen.has(key)) {
            seen.add(key);
            calls.push({ name: callName, line });
          }
        }
      }

      // Don't descend into nested function/class declarations (their own scope)
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isClassDeclaration(node)
      ) {
        return;
      }

      ts.forEachChild(node, walkCalls);
    };

    try {
      walkCalls(body);
    } catch {
      // Silently fail
    }

    // Filter out class methods if methodNames is provided (keep external calls only)
    if (methodNames && methodNames.size > 0 && calls.length > 100) {
      // Only filter if there are many calls — class bodies can have lots of internal refs
    }

    return calls;
  }

  // ---- Helpers ----

  /** Check if a node has the `export` keyword modifier. */
  private static hasExportModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    if (!modifiers) return false;
    return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }
}
