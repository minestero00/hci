/** Four operations only; no eval, variables, percentages or problem-solving shortcuts. */
export function calculate(input) {
  const s = String(input)
    .replace(/\s/g, "")
    .replace(/[×]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/−/g, "-");
  if (!s || s.length > 120 || /[^\d.+*/()\-]/.test(s))
    throw Error("숫자·괄호와 사칙연산만 입력해 주세요.");
  let i = 0;
  function atom() {
    let sign = 1;
    while (s[i] === "+" || s[i] === "-") {
      if (s[i++] === "-") sign *= -1;
    }
    let n;
    if (s[i] === "(") {
      i++;
      n = expression();
      if (s[i++] !== ")") throw Error("괄호를 확인해 주세요.");
    } else {
      const m = s.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (!m) throw Error("식을 확인해 주세요.");
      n = Number(m[0]);
      i += m[0].length;
    }
    return sign * n;
  }
  function term() {
    let n = atom();
    while (s[i] === "*" || s[i] === "/") {
      const op = s[i++],
        v = atom();
      if (op === "/" && v === 0) throw Error("0으로 나눌 수 없습니다.");
      n = op === "*" ? n * v : n / v;
    }
    return n;
  }
  function expression() {
    let n = term();
    while (s[i] === "+" || s[i] === "-") {
      const op = s[i++],
        v = term();
      n = op === "+" ? n + v : n - v;
    }
    return n;
  }
  const n = expression();
  if (i !== s.length || !Number.isFinite(n)) throw Error("식을 확인해 주세요.");
  return Number(n.toPrecision(12));
}
