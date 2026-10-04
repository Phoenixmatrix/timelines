---
description: Durable Objects compute and storage billing, including pricing examples and free tier limits.
title: Pricing
image: https://developers.cloudflare.com/durable-objects/platform/pricing/og.png?v=692e099f34a1b330
---

[Skip to content](#main-content)

> Documentation Index  
> Fetch the complete documentation index at: https://developers.cloudflare.com/durable-objects/llms.txt  
> Use this file to discover all available pages before exploring further.

# Pricing

Last updated Sep 30, 2026|Copy as Markdown| [View as Markdown](https://developers.cloudflare.com/durable-objects/platform/pricing/index.md)| [Agent setup](https://developers.cloudflare.com/agent-setup/)

Durable Objects can incur two types of billing: compute and storage.

Note

Durable Objects are available both on Workers Free and Workers Paid plans.

- **Workers Free plan**: Only Durable Objects with [SQLite storage backend](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/#create-sqlite-backed-durable-object-class) are available.
- **Workers Paid plan**: Durable Objects with the SQLite storage backend are available. The [key-value storage backend](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#storage-backends) is only available to accounts that already have a key-value-backed namespace.

If you wish to downgrade from a Workers Paid plan to a Workers Free plan, you must first ensure that you have deleted all Durable Object namespaces with the key-value storage backend.

On Workers Free plan:

- If you exceed any one of the free tier limits, further operations of that type will fail with an error.
- Daily free limits reset at 00:00 UTC.

## Compute billing

Durable Objects are billed for compute duration (wall-clock time) while the Durable Object is actively running or is idle in memory but unable to [hibernate](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/). Durable Objects that are idle and eligible for hibernation are not billed for duration, even before the runtime has hibernated them. Requests to a Durable Object keep it active or create the object if it was inactive.

For each metered dimension, billable usage is the amount consumed in excess of the included monthly allocation. This billable usage is rounded up to the next billable unit before the corresponding rate is applied. For example, 500,000 GB-s of billable compute duration is rounded up to 1,000,000 GB-s and billed accordingly.

|  | Free plan | Paid plan |
| --- | --- | --- |
| Requests | 100,000 / day | 1 million / month, + $0.15/million<br> Includes HTTP requests, RPC sessions<sup>1</sup>, WebSocket messages<sup>2</sup>, and alarm invocations |
| Duration<sup>3</sup> | 13,000 GB-s / day | 400,000 GB-s / month, + $12.50/million GB-s<sup>4,5</sup> |

<details>

<summary>

Footnotes

</summary>

<sup>1</sup> Each <a href="https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/">RPC session</a> is billed as one request to your Durable Object. Every <a href="https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/">RPC method call</a> on a <a href="https://developers.cloudflare.com/durable-objects/">Durable Objects stub</a> is its own RPC session and therefore a single billed request.

RPC method calls can return objects (stubs) extending <a href="https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#lifetimes-memory-and-resource-management"><code>RpcTarget</code></a> and invoke calls on those stubs. Subsequent calls on the returned stub are part of the same RPC session and are not billed as separate requests. For example:

```js
let durableObjectStub = OBJECT_NAMESPACE.get(id); // retrieve Durable Object stub
using foo = await durableObjectStub.bar(); // billed as a request
await foo.baz(); // treated as part of the same RPC session created by calling bar(), not billed as a request
await durableObjectStub.cat(); // billed as a request
```

<sup>2</sup> A request is needed to create a WebSocket connection. There is no charge for outgoing WebSocket messages, nor for incoming <a href="https://www.rfc-editor.org/rfc/rfc6455#section-5.5.2">WebSocket protocol pings ↗︎</a>. For compute requests billing-only, a 20:1 ratio is applied to incoming WebSocket messages to factor in smaller messages for real-time communication. For example, 100 WebSocket incoming messages would be charged as 5 requests for billing purposes. The 20:1 ratio does not affect Durable Object metrics and analytics, which reflect actual usage.

<sup>3</sup> Application level auto-response messages handled by <a href="https://developers.cloudflare.com/durable-objects/best-practices/websockets/"><code>state.setWebSocketAutoResponse()</code></a> will not incur additional wall-clock time, and so they will not be charged.

<sup>4</sup> Duration is billed in wall-clock time as long as the Object is active and not eligible for hibernation, but is shared across all requests active on an Object at once. Calling <code>accept()</code> on a WebSocket in an Object will incur duration charges for the entire time the WebSocket is connected. It is recommended to use the WebSocket Hibernation API to avoid incurring duration charges once all event handlers finish running. For a complete explanation, refer to <a href="https://developers.cloudflare.com/durable-objects/platform/pricing/#when-does-a-durable-object-incur-duration-charges">When does a Durable Object incur duration charges?</a>.

<sup>5</sup> Duration billing charges for the 128 MB of memory your Durable Object is allocated, regardless of actual usage. If your account creates many instances of a single Durable Object class, Durable Objects may run in the same isolate on the same physical machine and share the 128 MB of memory. These Durable Objects are still billed as if they are allocated a full 128 MB of memory.

</details>

## Storage billing

The [Durable Objects Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) is only accessible from within Durable Objects. Pricing depends on the storage backend of your Durable Objects.

- **SQLite-backed Durable Objects (recommended)**: [SQLite storage backend](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/#create-sqlite-backed-durable-object-class) is recommended for all new Durable Object classes. Workers Free plan can only create and access SQLite-backed Durable Objects.
- **Key-value backed Durable Objects**: [Key-value storage backend](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#create-durable-object-class-with-key-value-storage) is only available on the Workers Paid plan.

### SQLite storage backend

Storage billing on SQLite-backed Durable Objects

Storage billing for SQLite-backed Durable Objects will be enabled in January 2026, with a target date of January 7, 2026 (no earlier). Only SQLite storage usage on and after the billing target date will incur charges. For more information, refer to [Billing for SQLite Storage](https://developers.cloudflare.com/changelog/2025-12-12-durable-objects-sqlite-storage-billing/).

|  | Workers Free plan | Workers Paid plan |
| --- | --- | --- |
| Rows reads <sup>1,2</sup> | 5 million / day | First 25 billion / month included + $0.001 / million rows |
| Rows written <sup>1,2,3,4</sup> | 100,000 / day | First 50 million / month included + $1.00 / million rows |
| SQL Stored data <sup>5</sup> | 5 GB (total) | 5 GB-month, + $0.20/ GB-month |

<details>

<summary>

Footnotes

</summary>

<sup>1</sup> Rows read and rows written included limits and rates match <a href="https://developers.cloudflare.com/d1/platform/pricing/">D1 pricing</a>, Cloudflare's serverless SQL database.

<sup>2</sup> Key-value methods like <code>get()</code>, <code>put()</code>, <code>delete()</code>, or <code>list()</code> store and query data in a hidden SQLite table and are billed as rows read and rows written.

<sup>3</sup> Each <code>setAlarm()</code> is billed as a single row written.

<sup>4</sup> Deletes are counted as rows written.

<sup>5</sup> Durable Objects will be billed for stored data until the <a href="https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/#remove-a-durable-objects-storage">data is removed</a>. Once the data is removed, the object will be cleaned up automatically by the system.

</details>

### Key-value storage backend

|  | Workers Paid plan |
| --- | --- |
| Read request units<sup>1,2</sup> | 1 million, + $0.20/million |
| Write request units<sup>3</sup> | 1 million, + $1.00/million |
| Delete requests<sup>4</sup> | 1 million, + $1.00/million |
| Stored data<sup>5</sup> | 1 GB, + $0.20/ GB-month |

<details>

<summary>

Footnotes

</summary>

<sup>1</sup> A request unit is defined as 4 KB of data read or written. A request that writes or reads more than 4 KB will consume multiple units, for example, a 9 KB write will consume 3 write request units.

<sup>2</sup> List operations are billed by read request units, based on the amount of data examined. For example, a list request that returns a combined 80 KB of keys and values will be billed 20 read request units. A list request that does not return anything is billed for 1 read request unit.

<sup>3</sup> Each <code>setAlarm</code> is billed as a single write request unit.

<sup>4</sup> Delete requests are unmetered. For example, deleting a 100 KB value will be charged one delete request.

<sup>5</sup> Durable Objects will be billed for stored data until the data is removed. Once the data is removed, the object will be cleaned up automatically by the system.

Requests that hit the <a href="https://developers.cloudflare.com/durable-objects/reference/in-memory-state/">Durable Objects in-memory cache</a> or that use the <a href="https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/">multi-key versions of <code>get()</code>/<code>put()</code>/<code>delete()</code> methods</a> are billed the same as if they were a normal, individual request for each key.

</details>

## Compute billing examples

These examples exclude the costs for the Workers calling the Durable Objects. When modelling the costs of a Durable Object, note that:

- Inactive objects receiving no requests do not incur any duration charges.
- The [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#durable-objects-hibernation-websocket-api) can dramatically reduce duration-related charges for Durable Objects communicating with clients over the WebSocket protocol, especially if messages are only transmitted occasionally at sparse intervals.
- Pending I/O operations keep an object in memory for up to 15 minutes each. The object incurs duration charges during that time. For more information, refer to [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

### Example 1

This example represents a simple Durable Object used as a co-ordination service invoked via HTTP.

- A single Durable Object was called by a Worker 1.5 million times
- It is active for 1,000,000 seconds in the month

In this scenario, the estimated monthly cost would be calculated as:

**Requests**:

- 1.5 million requests - included 1 million requests = 500,000 billable requests.
- (rounded) 1,000,000 requests x $0.15 / 1,000,000 = $0.15.

**Compute Duration**:

- 1,000,000 seconds \* 128 MB / 1 GB = 128,000 GB-s.
- 128,000 GB-s is within the 400,000 GB-s included allocation = $0.00.

**Estimated total**: $0.15 (requests) + $0.00 (compute duration) + minimum $5/mo usage = $5.15 per month

### Example 2

This example represents a moderately trafficked Durable Objects based application using WebSockets to broadcast game, chat or real-time user state across connected clients:

- 100 Durable Objects have 50 WebSocket connections established to each of them.
- Clients send approximately one message a minute for eight active hours a day, every day of the month.

In this scenario, the estimated monthly cost would be calculated as:

**Requests**:

- 50 WebSocket connections \* 100 Durable Objects to establish the WebSockets = 5,000 connections created each day \* 30 days = 150,000 WebSocket connection requests.
- 50 messages per minute \* 100 Durable Objects \* 60 minutes \* 8 hours \* 30 days = 72,000,000 WebSocket message requests.
- 150,000 + (72 million requests / 20 for WebSocket message billing ratio) = 3.75 million billing request.
- 3.75 million requests - included 1 million requests = 2,750,000 billable requests.
- (rounded) 3,000,000 requests x $0.15 / 1,000,000 = $0.45.

**Compute Duration**:

- 100 Durable Objects \* 60 seconds \* 60 minutes \* 8 hours \* 30 days = 86,400,000 seconds.
- 86,400,000 seconds \* 128 MB / 1 GB = 11,059,200 GB-s.
- 11,059,200 GB-s - included 400,000 GB-s = 10,659,200 GB-s
- (rounded) 11,000,000 GB-s x $12.50 / 1,000,000 = $137.50.

**Estimated total**: $0.45 (requests) + $137.50 (compute duration) + minimum $5/mo usage = $142.95 per month.

### Example 3

This example represents a horizontally scaled Durable Objects based application using WebSockets to communicate user-specific state to a single client connected to each Durable Object.

- 100 Durable Objects each have a single WebSocket connection established to each of them.
- Clients sent one message every second of the month so that the Durable Objects were active for the entire month.

In this scenario, the estimated monthly cost would be calculated as:

**Requests**:

- 100 WebSocket connection requests.
- 1 message per second \* 100 connections \* 60 seconds \* 60 minutes \* 24 hours \* 30 days = 259,200,000 WebSocket message requests.
- 100 + (259.2 million requests / 20 for WebSocket billing ratio) = 12,960,100 requests.
- 12,960,100 requests - included 1 million requests = 11,960,100 billable requests.
- (rounded) 12,000,000 requests x $0.15 / 1,000,000 = $1.80.

**Compute Duration**:

- 100 Durable Objects \* 60 seconds \* 60 minutes \* 24 hours \* 30 days = 259,200,000 seconds
- 259,200,000 seconds \* 128 MB / 1 GB = 33,177,600 GB-s
- 33,177,600 GB-s - included 400,000 GB-s = 32,777,600 GB-s
- (rounded) 33,000,000 GB-s x $12.50 / 1,000,000 = $412.50

**Estimated total**: $1.80 (requests) + $412.50 (compute duration) + minimum $5/mo usage = $419.30 per month

### Example 4

This example represents a moderately trafficked Durable Objects based application using WebSocket Hibernation to broadcast game, chat or real-time user state across connected clients:

- 100 Durable Objects each have 100 Hibernatable WebSocket connections established to each of them.
- Clients send one message per minute, and it takes 10ms to process a single message in the `webSocketMessage()` handler. Since each Durable Object handles 100 WebSockets, cumulatively each Durable Object will be actively executing JS for 1 second each minute (100 WebSockets \* 10ms).

In this scenario, the estimated monthly cost would be calculated as:

**Requests**:

- 100 WebSocket connections \* 100 Durable Objects to establish the WebSockets = 10,000 initial WebSocket connection requests.
- 100 messages per minute<sup>1</sup> \* 100 Durable Objects \* 60 minutes \* 24 hours \* 30 days = 432,000,000 requests.
- 10,000 + (432 million requests / 20 for WebSocket billing ratio) = 21,610,000 million requests.
- 21,610,000 requests - included 1 million requests = 20,610,000 billable requests.
- (rounded) 21,000,000 requests x $0.15 / 1,000,000 = $3.15.

**Compute Duration**:

- 100 Durable Objects \* 1 second<sup>2</sup> \* 60 minutes \* 24 hours \* 30 days = 4,320,000 seconds
- 4,320,000 seconds \* 128 MB / 1 GB = 552,960 GB-s
- 552,960 GB-s - included 400,000 GB-s = 152,960 GB-s
- (rounded) 1,000,000 GB-s x $12.50 / 1,000,000 = $12.50

**Estimated total**: $3.15 (requests) + $12.50 (compute duration) + minimum $5/mo usage = $20.65 per month

<sup>1</sup> 100 messages per minute comes from the fact that 100 clients connect to each DO, and each sends 1 message per minute.

<sup>2</sup> The example uses 1 second because each Durable Object is active for 1 second per minute. This can also be thought of as 432 million requests that each take 10 ms to execute (4,320,000 seconds).

## Frequently Asked Questions

### When does a Durable Object incur duration charges?

A Durable Object incurs duration charges when it is actively executing JavaScript — either handling a request or running event handlers — or when it is idle but does not meet the [conditions for hibernation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/). An idle Durable Object that qualifies for hibernation does not incur duration charges, even during the brief window before the runtime hibernates it.

Once an object has been evicted from memory, the next time it is needed, it will be recreated (calling the constructor again).

There are several factors that can prevent a Durable Object from hibernating and cause it to continue incurring duration charges.

Find more information in [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

### Does an empty table / SQLite database contribute to my storage?

Yes, although minimal. Empty tables can consume at least a few kilobytes, based on the number of columns (table width) in the table. An empty SQLite database consumes approximately 12 KB of storage.

### Does metadata stored in Durable Objects count towards my storage?

All writes to a SQLite-backed Durable Object stores nominal amounts of metadata in internal tables in the Durable Object, which counts towards your billable storage.

The metadata remains in the Durable Object until you call [`deleteAll()`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#deleteall).

Was this helpful?

YesNo

## On this page

[![](https://developers.cloudflare.com/_astro/logo.te5VL_aD.svg)Docs](https://developers.cloudflare.com/)

```json
{"@context":"https://schema.org","@type":"TechArticle","@id":"https://developers.cloudflare.com/durable-objects/platform/pricing/#page","headline":"Pricing","description":"Durable Objects compute and storage billing, including pricing examples and free tier limits.","url":"https://developers.cloudflare.com/durable-objects/platform/pricing/","inLanguage":"en","image":"https://developers.cloudflare.com/durable-objects/platform/pricing/og.png?v=692e099f34a1b330","dateModified":"2026-09-30","publisher":{"@type":"Organization","name":"Cloudflare","description":"One platform for your apps, agents, and workforce. Build, secure, and scale without managing infrastructure","url":"https://www.cloudflare.com/","sameAs":["https://github.com/cloudflare","https://www.linkedin.com/company/cloudflare","https://x.com/cloudflare"],"logo":{"@type":"ImageObject","url":"https://developers.cloudflare.com/logo.svg"},"address":{"@type":"PostalAddress","streetAddress":"101 Townsend St","addressLocality":"San Francisco","addressRegion":"CA","postalCode":"94107","addressCountry":"US"},"contactPoint":[{"@type":"ContactPoint","contactType":"Customer Support","url":"https://support.cloudflare.com/","availableLanguage":["English"]},{"@type":"ContactPoint","contactType":"Sales","url":"https://www.cloudflare.com/contact/","availableLanguage":["English"]}]},"isPartOf":{"@type":"WebSite","@id":"https://developers.cloudflare.com/#website","name":"Cloudflare Docs","url":"https://developers.cloudflare.com/"}}
```
