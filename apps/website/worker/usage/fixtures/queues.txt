---
description: Cloudflare Queues pricing for standard operations with included free usage.
title: Pricing
image: https://developers.cloudflare.com/queues/platform/pricing/og.png?v=f8e8dd0441bcf01e
---

[Skip to content](#main-content)

> Documentation Index  
> Fetch the complete documentation index at: https://developers.cloudflare.com/queues/llms.txt  
> Use this file to discover all available pages before exploring further.

# Pricing

Last updated Apr 21, 2026|Copy as Markdown| [View as Markdown](https://developers.cloudflare.com/queues/platform/pricing/index.md)| [Agent setup](https://developers.cloudflare.com/agent-setup/)

Cloudflare Queues charges for the total number of operations against each of your queues during a given month.

- An operation is counted for each 64 KB of data that is written, read, or deleted.
- Messages larger than 64 KB are charged as if they were multiple messages: for example, a 65 KB message and a 127 KB message would both incur two operation charges when written, read, or deleted.
- A KB is defined as 1,000 bytes, and each message includes approximately 100 bytes of internal metadata.
- Operations are per message, not per batch. A batch of 10 messages (the default batch size), if processed, would incur 10x write, 10x read, and 10x delete operations: one for each message in the batch.
- There are no data transfer (egress) or throughput (bandwidth) charges.

|  | Workers Free | Workers Paid |
| --- | --- | --- |
| Standard operations | 10,000 operations/day included | 1,000,000 operations/month included + $0.40/million operations |
| Message retention | 24 hours (non-configurable) | 4 days default, configurable up to 14 days |

In most cases, it takes 3 operations to deliver a message: 1 write, 1 read, and 1 delete. Therefore, you can use the following formula to estimate your monthly bill:

```txt
((Number of Messages * 3) - 1,000,000) / 1,000,000  * $0.40
```

Additionally:

- Each retry incurs a read operation. A batch of 10 messages that is retried would incur 10 operations for each retry.
- Messages that reach the maximum retries and that are written to a [Dead Letter Queue](https://developers.cloudflare.com/queues/configuration/batching-retries/) incur a write operation for each 64 KB chunk. A message that was retried 3 times (the default), fails delivery on the fourth time and is written to a Dead Letter Queue would incur five (5) read operations.
- Messages that are written to a queue, but that reach the maximum persistence duration (or "expire") before they are read, incur only a write and delete operation per 64 KB chunk.

## Examples

If an application writes, reads and deletes (consumes) one million messages a day (in a 30 day month), and each message is less than 64 KB in size, the estimated bill for the month would be:

|  | Total Usage | Free Usage | Billed Usage | Price |
| --- | --- | --- | --- | --- |
| Standard operations | 3 \* 30 \* 1,000,000 | 1,000,000 | 89,000,000 | $35.60 |
|  | (write, read, delete) |  |  | |
| **TOTAL** |  |  |  | **$35.60** |

An application that writes, reads and deletes (consumes) 100 million \~127 KB messages (each message counts as two 64 KB chunks) per month would have an estimated bill resembling the following:

|  | Total Usage | Free Usage | Billed Usage | Price |
| --- | --- | --- | --- | --- |
| Standard operations | 2 \* 3 \* 100 \* 1,000,000 | 1,000,000 | 599,000,000 | $239.60 |
|  | (2x ops for > 64KB messages) |  |  | |
| **TOTAL** |  |  |  | **$239.60** |

Was this helpful?

YesNo

## On this page

[![](https://developers.cloudflare.com/_astro/logo.te5VL_aD.svg)Docs](https://developers.cloudflare.com/)

```json
{"@context":"https://schema.org","@type":"TechArticle","@id":"https://developers.cloudflare.com/queues/platform/pricing/#page","headline":"Pricing","description":"Cloudflare Queues pricing for standard operations with included free usage.","url":"https://developers.cloudflare.com/queues/platform/pricing/","inLanguage":"en","image":"https://developers.cloudflare.com/queues/platform/pricing/og.png?v=f8e8dd0441bcf01e","dateModified":"2026-04-21","publisher":{"@type":"Organization","name":"Cloudflare","description":"One platform for your apps, agents, and workforce. Build, secure, and scale without managing infrastructure","url":"https://www.cloudflare.com/","sameAs":["https://github.com/cloudflare","https://www.linkedin.com/company/cloudflare","https://x.com/cloudflare"],"logo":{"@type":"ImageObject","url":"https://developers.cloudflare.com/logo.svg"},"address":{"@type":"PostalAddress","streetAddress":"101 Townsend St","addressLocality":"San Francisco","addressRegion":"CA","postalCode":"94107","addressCountry":"US"},"contactPoint":[{"@type":"ContactPoint","contactType":"Customer Support","url":"https://support.cloudflare.com/","availableLanguage":["English"]},{"@type":"ContactPoint","contactType":"Sales","url":"https://www.cloudflare.com/contact/","availableLanguage":["English"]}]},"isPartOf":{"@type":"WebSite","@id":"https://developers.cloudflare.com/#website","name":"Cloudflare Docs","url":"https://developers.cloudflare.com/"}}
```
