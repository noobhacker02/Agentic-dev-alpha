const {slugify} = require(process.argv[2] + "/slugify.js"); const cases = [
 ["  Hello---World  ","hello-world"],["Hello World","hello-world"],["a  b","a-b"],["--a--","a"],["","" ],["   ",""],["!!!",""],
 ["Hello, World!","hello-world"],["Ünïcödé Straße","?"],["tab\there","tab-here"],["a_b","a-b"],["x".repeat(10000),"x".repeat(10000)],["Café","?"],["123 go","123-go"]];
let pass=0; const fails=[]; for (const [i,w] of cases) { let got; try { got = slugify(i); } catch(e){ got = "THREW "+e.message; }
 if (w==="?") { const ok = typeof got==="string" && !/^-|-$/.test(got) && got.length>0; ok?pass++:fails.push(`${JSON.stringify(i)} -> ${JSON.stringify(got)} (non-ASCII input lost entirely or bad dashes)`); continue; }
 got===w?pass++:fails.push(`${JSON.stringify(i).slice(0,30)} -> ${JSON.stringify(got).slice(0,30)} want ${JSON.stringify(w).slice(0,30)}`); }
try { slugify(null); fails.push("slugify(null) did not throw a clear error") } catch(e) { pass++ }
console.log(`hidden grader: ${pass}/${cases.length+1} passed`); fails.forEach(f=>console.log("  -",f));
