// 无状态补全（/api/complete）的纯逻辑：把模型返回的文本尽力解析成 JSON。
// 即便请求里带了 outputSchema，模型偶尔也会用 ```json 围栏包裹或在 JSON 前后多写几句话，
// 所以这里做三层兜底：原文 → 去围栏 → 截取首个 { 或 [ 到对应收尾符。全失败才返回 ok:false。

export function tryParseJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return { ok: false, error: '空响应' };
  }

  const candidates = [raw];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    candidates.unshift(fenced[1].trim());
  }

  const sliced = sliceJsonLike(raw);
  if (sliced) {
    candidates.push(sliced);
  }

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // 试下一个候选
    }
  }

  return { ok: false, error: '返回内容不是合法 JSON' };
}

// 把任意 JSON Schema 规整成 OpenAI 结构化输出（strict 模式）要求的形态，让调用方不必记这些坑：
//   1) 每个 object 节点必须带 additionalProperties: false；
//   2) strict 模式要求 object 的 required 列出全部 property（“可选”需用 nullable 类型表达）。
// 递归覆盖 properties / items / anyOf|oneOf|allOf / $defs|definitions。纯函数，不改入参。
export function toStrictJsonSchema(schema) {
  if (Array.isArray(schema)) {
    return schema.map(toStrictJsonSchema);
  }
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const out = { ...schema };

  if (out.properties && typeof out.properties === 'object') {
    const props = {};
    for (const [key, value] of Object.entries(out.properties)) {
      props[key] = toStrictJsonSchema(value);
    }
    out.properties = props;
  }
  if (out.items !== undefined) {
    out.items = toStrictJsonSchema(out.items);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(out[key])) {
      out[key] = out[key].map(toStrictJsonSchema);
    }
  }
  for (const key of ['$defs', 'definitions']) {
    if (out[key] && typeof out[key] === 'object') {
      const defs = {};
      for (const [name, value] of Object.entries(out[key])) {
        defs[name] = toStrictJsonSchema(value);
      }
      out[key] = defs;
    }
  }

  const typeIsObject = Array.isArray(out.type) ? out.type.includes('object') : out.type === 'object';
  const looksLikeObject = typeIsObject || (out.properties && out.type === undefined);
  if (looksLikeObject) {
    out.additionalProperties = false;
    if (out.properties) {
      out.required = Object.keys(out.properties);
    }
  }

  return out;
}

// 从一段文本里截出最外层的 JSON 片段：取第一个 `{` 或 `[`（谁先出现），
// 到与之匹配的最后一个 `}` 或 `]`。用于剥掉 JSON 前后的解释性文字。
export function sliceJsonLike(text) {
  const source = String(text ?? '');
  const firstObj = source.indexOf('{');
  const firstArr = source.indexOf('[');

  let start;
  if (firstObj === -1) {
    start = firstArr;
  } else if (firstArr === -1) {
    start = firstObj;
  } else {
    start = Math.min(firstObj, firstArr);
  }
  if (start === -1) {
    return null;
  }

  const close = source[start] === '{' ? '}' : ']';
  const end = source.lastIndexOf(close);
  if (end <= start) {
    return null;
  }

  return source.slice(start, end + 1);
}
