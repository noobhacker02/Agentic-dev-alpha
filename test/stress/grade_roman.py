import sys, subprocess, importlib.util, os
d = sys.argv[1]; p = os.path.join(d, "roman.py")
if not os.path.exists(p): print("roman.py MISSING"); sys.exit()
spec = importlib.util.spec_from_file_location("roman", p); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
fails = []
for n in range(1, 4000):
    try:
        s = m.to_roman(n)
        if m.from_roman(s) != n: fails.append(f"roundtrip {n}")
    except Exception as e: fails.append(f"roundtrip {n}: {e!r}"); 
bad_ints = [0, 4000, -1, 10**9, True, 3.0, "12", None]
for b in bad_ints:
    try: m.to_roman(b); fails.append(f"to_roman({b!r}) accepted")
    except (ValueError, TypeError): pass
    except Exception as e: fails.append(f"{b!r}: wrong exception {type(e).__name__}")
bad_strs = ["IIII","VX","IC","MMMM","", "IIV","XM","VV","LL","DD","IL","XD","CCCC","MCMC","IXIX"," XIV","XIV\n","mcm","Ⅻ","0","-I", None, 5]
for b in bad_strs:
    try: r = m.from_roman(b); fails.append(f"from_roman({b!r}) -> {r!r} accepted")
    except (ValueError, TypeError): pass
    except Exception as e: fails.append(f"{b!r}: wrong exception {type(e).__name__}")
cli = [(["1994"],0,"MCMXCIV"),(["MCMXCIV"],0,"1994"),(["0"],2,None),(["4000"],2,None),(["IIII"],2,None),([],2,None),(["abc"],2,None),(["1","2"],2,None),(["--help"],None,None),(["-5"],2,None)]
for args, code, out in cli:
    r = subprocess.run([sys.executable, p, *args], capture_output=True, text=True)
    if code is not None and r.returncode != code: fails.append(f"CLI {args}: exit {r.returncode} want {code}")
    if out and r.stdout.strip() != out: fails.append(f"CLI {args}: stdout {r.stdout.strip()!r}")
    if code == 2 and not r.stderr.strip(): fails.append(f"CLI {args}: no stderr message")
total = 3999 + len(bad_ints) + len(bad_strs) + len(cli)
print(f"hidden grader: {total-len(fails)}/{total} passed"); [print("  -", f) for f in fails[:25]]
