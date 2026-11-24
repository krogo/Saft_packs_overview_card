import asyncio, http.server, threading, functools
from playwright.async_api import async_playwright
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), functools.partial(http.server.SimpleHTTPRequestHandler, directory=".."))
threading.Thread(target=srv.serve_forever, daemon=True).start()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1000, "height": 900}, device_scale_factor=1.5)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        for theme, st, out in (("dark", "states.json", "dark"), ("light", "states.json", "light"), ("dark", "states_mixed.json", "mixed")):
            await pg.goto(f"http://127.0.0.1:8766/tests/index.html?theme={theme}&states={st}")
            await pg.wait_for_function("window.__ready === true", timeout=10000)
            await pg.wait_for_timeout(400)
            await pg.locator("saft-packs-card").screenshot(path=f"{out}.png")
            print(out, await pg.evaluate("window.__cards[0].shadowRoot.querySelector('.kv').innerText.replace(/\\s+/g,' ')"))
            print("  ", await pg.evaluate("window.__cards[0].shadowRoot.querySelector('.note')?.innerText"))
        await pg.evaluate("window.__cards[0].shadowRoot.querySelector('.pk').click()")
        print("more-info:", await pg.evaluate("window.__events"))
        print("errors:", errs)
        await b.close()
asyncio.run(main())
