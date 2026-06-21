const HIDDEN_DIRECTIVE_MARKERS = ['::inbox-item{'];

export function stripHiddenCodexDirectives(value, { final = true } = {}) {
  const text = String(value ?? '');
  let output = '';
  let index = 0;

  while (index < text.length) {
    const directiveIndex = text.indexOf('::', index);
    if (directiveIndex === -1) {
      output += text.slice(index);
      break;
    }

    if (!isLineStartDirective(text, directiveIndex)) {
      output += text.slice(index, directiveIndex + 2);
      index = directiveIndex + 2;
      continue;
    }

    const marker = HIDDEN_DIRECTIVE_MARKERS.find((item) => text.startsWith(item, directiveIndex));
    if (!marker) {
      output += text.slice(index, directiveIndex + 2);
      index = directiveIndex + 2;
      continue;
    }

    output += text.slice(index, directiveIndex);
    const end = findDirectiveEnd(text, directiveIndex + marker.length - 1);
    if (end === -1) {
      if (!final) {
        const split = splitTrailingWhitespace(output);
        return { text: split.visible, pending: split.pending + text.slice(directiveIndex) };
      }
      break;
    }
    index = end;
  }

  return { text: final ? normalizeVisibleText(output) : output, pending: '' };
}

export function createHiddenCodexDirectiveStreamFilter() {
  let pending = '';

  return {
    push(chunk) {
      const result = stripHiddenCodexDirectives(pending + String(chunk ?? ''), { final: false });
      let visible = result.text;
      const holdStart = findStreamHoldStart(visible);
      pending = visible.slice(holdStart) + result.pending;
      visible = visible.slice(0, holdStart);
      return visible;
    },
    flush() {
      const result = stripHiddenCodexDirectives(pending, { final: true });
      pending = '';
      return result.text;
    },
  };
}

function isLineStartDirective(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, index));
}

function findDirectiveEnd(text, openBraceIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let index = openBraceIndex; index < text.length; index += 1) {
    const ch = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

function findStreamHoldStart(text) {
  let holdStart = text.length;
  const prefixStart = findHiddenDirectivePrefixStart(text);
  if (prefixStart !== -1) {
    holdStart = Math.min(holdStart, prefixStart);
  }

  const trailing = /[ \t\r\n]*$/.exec(text);
  if (trailing) {
    holdStart = Math.min(holdStart, trailing.index);
  }
  return holdStart;
}

function findHiddenDirectivePrefixStart(text) {
  for (const marker of HIDDEN_DIRECTIVE_MARKERS) {
    const maxLength = Math.min(marker.length - 1, text.length);
    for (let length = maxLength; length > 0; length -= 1) {
      const start = text.length - length;
      if (!marker.startsWith(text.slice(start))) {
        continue;
      }
      if (!isLineStartDirective(text, start)) {
        continue;
      }
      let holdStart = start;
      while (holdStart > 0 && /\s/.test(text[holdStart - 1])) {
        holdStart -= 1;
      }
      return holdStart;
    }
  }
  return -1;
}

function splitTrailingWhitespace(text) {
  const trailing = /[ \t\r\n]*$/.exec(text);
  const splitIndex = trailing ? trailing.index : text.length;
  return {
    visible: text.slice(0, splitIndex),
    pending: text.slice(splitIndex),
  };
}

function normalizeVisibleText(text) {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
