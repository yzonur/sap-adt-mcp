# LinkedIn launch post — drafts

Two versions, pick one. Both should be paired with either:

1. A 30–60 second screen recording of an agent doing something real (compare
   a class across DEV/PRD, audit a package, run unit tests). The video is
   what makes this go anywhere — without it the post is "another tool
   announcement."
2. Failing that, a single screenshot of a chat showing the agent reading an
   ABAP class through the MCP and explaining it.

---

## Draft A — short, technical, English

> I open-sourced **claude-for-abap** — an MCP server that lets Claude read
> source, search, run syntax checks, run unit tests, and edit ABAP across any
> SAP system that exposes ADT (every modern NetWeaver / S/4 does, by default).
>
> No add-on on the SAP stack. No abapGit step. The agent talks to the same
> REST API Eclipse ADT uses — auth, CSRF, sap-client, cookies are handled.
> Multi-system aware (one config, many landscapes), with a `readOnly` safety
> flag for QAS/PRD.
>
> 14 high-level tools wrapping the common workflows (get/set source, where-
> used, search, package walk, cross-system diff, transport diff, ATC, ABAP
> Unit, activate). Plus a generic escape hatch for niche endpoints.
>
> MIT-licensed. Repo + install: github.com/yzonur/claude-for-abap
>
> [video / screenshot here]
>
> #SAP #ABAP #AI #ClaudeAI #MCP #DeveloperTools

---

## Draft B — story-led, Turkish

> SAP'de aynı işi her hafta yapıyoruz: bir class'ın DEV ve PRD'de aynı olup
> olmadığına bakmak, transport'un içinde ne taşındığını görmek, where-used
> çekip "bunu bozarsam ne kırılır" demek, ATC çıktılarına göz gezdirmek.
>
> Bu işleri Claude'a yaptırmak için bir MCP server yazdım: **claude-for-abap**.
> ADT REST üzerinden her modern NetWeaver / S/4 sistemine bağlanıyor. Eclipse
> ADT'nin konuştuğu API'yle aynı. SAP tarafında kurulum yok, abapGit gibi bir
> ara katman yok.
>
> Tek config'le birden fazla sistem (DEV / QAS / PRD), QAS ve PRD için
> `readOnly` flag'i, yazma operasyonlarında lock → PUT → unlock orkestrasyonu,
> CSRF/cookie/sap-client otomatik yönetimi. ATC, ABAP Unit, syntax check,
> aktivasyon, paket tarama, transport diff, cross-system karşılaştırma.
>
> 14 tool, MIT lisans, npx ile çalıştırılabilir. Repo:
> github.com/yzonur/claude-for-abap
>
> [video]
>
> ABAP'çı arkadaşlar — hangi senaryolar için kullanmayı düşünürsünüz? Yorum
> olarak yazarsanız kapsamı genişletmek için backlog'a alırım.
>
> #SAP #ABAP #AI #ClaudeAI #MCP

---

## Hashtag pool

Pick 4–6 from this list, don't pile on:

- #SAP #ABAP #SAPDeveloper #SAPCommunity
- #ClaudeAI #Anthropic #MCP #ModelContextProtocol
- #AI #DeveloperTools #OpenSource
- (TR) #SAPgelistirici #YapayZeka

## Distribution checklist

- [ ] Post on personal LinkedIn
- [ ] Cross-post to relevant SAP / ABAP groups (LinkedIn groups, Discord, Reddit r/SAP)
- [ ] Tag the SAP Mentors community if appropriate
- [ ] Share to Türkçe SAP topluluklarına (SAP TR, ABAP TR Telegram/WhatsApp grupları)
- [ ] After 24h: a follow-up post showing one specific workflow in detail

## Post-launch followups

- A short blog post: *"Why I built claude-for-abap"* (Medium / dev.to)
- A technical post: *"ADT REST quirks I hit while wiring up an MCP server"*
  (CSRF + stateful sessions + lock management) — this is the SEO post
- Submit to MCP registries (Smithery, Anthropic's MCP listings)
- `npm publish --access public`
