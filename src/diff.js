// Minimal line-based unified diff using LCS DP.
// Adequate for ABAP source comparison (typically <5000 lines).
// Output mirrors the conventional `diff -u` format — well understood by LLMs.

export function unifiedLineDiff(a, b, { context = 3, fromFile = "a", toFile = "b" } = {}) {
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  const ops = lcsDiff(aLines, bLines);
  const hunks = collectHunks(ops, context);

  if (hunks.length === 0) {
    return { identical: true, diff: "", stats: { added: 0, removed: 0 } };
  }

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "+") added++;
    else if (op.kind === "-") removed++;
  }

  let out = `--- ${fromFile}\n+++ ${toFile}\n`;
  for (const h of hunks) {
    out += `@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@\n`;
    for (const line of h.lines) out += line + "\n";
  }
  return { identical: false, diff: out, stats: { added, removed } };
}

function splitLines(s) {
  if (typeof s !== "string") return [];
  if (s.length === 0) return [];
  const lines = s.split(/\r\n|\n|\r/);
  // split keeps a trailing empty entry if the string ends with a newline; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Returns a list of ops: { kind: " " | "-" | "+", text, ai, bi } where ai/bi are
// 1-based line numbers in original/new files (undefined for the missing side).
function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  // Standard LCS DP table.
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i], ai: i + 1, bi: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "-", text: a[i], ai: i + 1 });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j], bi: j + 1 });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "-", text: a[i], ai: i + 1 });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "+", text: b[j], bi: j + 1 });
    j++;
  }
  return ops;
}

function collectHunks(ops, context) {
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i].kind === " ") i++;
    if (i >= ops.length) break;

    const start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (ops[end].kind !== " ") {
        end++;
        continue;
      }
      // Look ahead: is the next change within 2*context lines?
      let gap = 0;
      let k = end;
      while (k < ops.length && ops[k].kind === " " && gap < 2 * context) {
        gap++;
        k++;
      }
      if (k < ops.length && ops[k].kind !== " " && gap < 2 * context) {
        end = k;
        continue;
      }
      break;
    }
    const tail = Math.min(ops.length, end + context);

    const slice = ops.slice(start, tail);
    const aStart = slice.find((o) => o.ai != null)?.ai ?? 0;
    const bStart = slice.find((o) => o.bi != null)?.bi ?? 0;
    let aLen = 0;
    let bLen = 0;
    const lines = [];
    for (const o of slice) {
      lines.push(o.kind + o.text);
      if (o.kind !== "+") aLen++;
      if (o.kind !== "-") bLen++;
    }
    hunks.push({ aStart, aLen, bStart, bLen, lines });
    i = tail;
  }
  return hunks;
}
