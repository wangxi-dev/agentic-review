// Sample JavaScript file to exercise the code renderer.
export function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

const greet = (name = "world") => `hello, ${name}`;

console.log(greet("agentic-review"));
