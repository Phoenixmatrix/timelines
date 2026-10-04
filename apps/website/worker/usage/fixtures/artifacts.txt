---
description: Review Artifacts pricing information.
title: Pricing
image: https://developers.cloudflare.com/artifacts/platform/pricing/og.png?v=d91474ce3a62ac8e
---

[Skip to content](#main-content)

> Documentation Index  
> Fetch the complete documentation index at: https://developers.cloudflare.com/artifacts/llms.txt  
> Use this file to discover all available pages before exploring further.

# Pricing

Last updated Oct 1, 2026|Copy as Markdown| [View as Markdown](https://developers.cloudflare.com/artifacts/platform/pricing/index.md)| [Agent setup](https://developers.cloudflare.com/agent-setup/)

Artifacts is currently only available on the Workers Paid plan.

Note

Cloudflare will begin billing for Artifacts operations and storage on October 14, 2026.

Artifacts pricing is billed on two dimensions:

- **Operations**: the number of repo operations, such as `create`, `push`, `pull`, and `clone`.
- **Storage**: the total amount of stored data, measured in gigabyte-months ( `GB-mo`).

## Artifacts pricing

| Unit | Workers Free | Workers Paid |
| --- | --- | --- |
| Operations (1,000 operations) | Unavailable | First 10,000 per month + $0.15 per additional 1,000 operations |
| Storage (GB-mo) | Unavailable | First 1 GB per month + $0.50 per additional GB-mo |

## Storage usage

Storage is billed using gigabyte-month (`GB-mo`) as the billing metric, identical to [Durable Objects SQL storage](https://developers.cloudflare.com/durable-objects/platform/pricing/#sqlite-storage-backend). A `GB-mo` is calculated by averaging peak storage per day over a 30-day billing period.

- Storage is calculated across all repositories.
- Replicas do not add storage charges. Storage is replicated by default, and you do not need to manage repository availability or uptime.
- Repos remain stored until you explicitly delete them.

Was this helpful?

YesNo

## On this page

[![](https://developers.cloudflare.com/_astro/logo.te5VL_aD.svg)Docs](https://developers.cloudflare.com/)

```json
{"@context":"https://schema.org","@type":"TechArticle","@id":"https://developers.cloudflare.com/artifacts/platform/pricing/#page","headline":"Pricing","description":"Review Artifacts pricing information.","url":"https://developers.cloudflare.com/artifacts/platform/pricing/","inLanguage":"en","image":"https://developers.cloudflare.com/artifacts/platform/pricing/og.png?v=d91474ce3a62ac8e","dateModified":"2026-10-01","publisher":{"@type":"Organization","name":"Cloudflare","description":"One platform for your apps, agents, and workforce. Build, secure, and scale without managing infrastructure","url":"https://www.cloudflare.com/","sameAs":["https://github.com/cloudflare","https://www.linkedin.com/company/cloudflare","https://x.com/cloudflare"],"logo":{"@type":"ImageObject","url":"https://developers.cloudflare.com/logo.svg"},"address":{"@type":"PostalAddress","streetAddress":"101 Townsend St","addressLocality":"San Francisco","addressRegion":"CA","postalCode":"94107","addressCountry":"US"},"contactPoint":[{"@type":"ContactPoint","contactType":"Customer Support","url":"https://support.cloudflare.com/","availableLanguage":["English"]},{"@type":"ContactPoint","contactType":"Sales","url":"https://www.cloudflare.com/contact/","availableLanguage":["English"]}]},"isPartOf":{"@type":"WebSite","@id":"https://developers.cloudflare.com/#website","name":"Cloudflare Docs","url":"https://developers.cloudflare.com/"}}
```
