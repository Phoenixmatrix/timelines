---
description: D1 pricing based on rows read, rows written, and storage with scale-to-zero billing.
title: Pricing
image: https://developers.cloudflare.com/d1/platform/pricing/og.png?v=69a8a81ee033787f
---

[Skip to content](#main-content)

> Documentation Index  
> Fetch the complete documentation index at: https://developers.cloudflare.com/d1/llms.txt  
> Use this file to discover all available pages before exploring further.

# Pricing

Last updated Apr 21, 2026|Copy as Markdown| [View as Markdown](https://developers.cloudflare.com/d1/platform/pricing/index.md)| [Agent setup](https://developers.cloudflare.com/agent-setup/)

D1 bills based on:

- **Usage**: Queries you run against D1 will count as rows read, rows written, or both (for transactions or batches).
- **Scale-to-zero**: You are not billed for hours or capacity units. If you are not running queries against your database, you are not billed for compute.
- **Storage**: You are only billed for storage above the included [limits](https://developers.cloudflare.com/d1/platform/limits/) of your plan.

## Billing metrics

|  | [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/#workers) | [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/#workers) |
| --- | --- | --- |
| Rows read | 5 million / day | First 25 billion / month included + $0.001 / million rows |
| Rows written | 100,000 / day | First 50 million / month included + $1.00 / million rows |
| Storage (per GB stored) | 5 GB (total) | First 5 GB included + $0.75 / GB-mo |

Track your D1 usage

To accurately track your usage, use the [meta object](https://developers.cloudflare.com/d1/worker-api/return-object/), [GraphQL Analytics API](https://developers.cloudflare.com/d1/observability/metrics-analytics/#query-via-the-graphql-api), or the [Cloudflare dashboard ↗︎](https://dash.cloudflare.com/?to=/:account/workers/d1/). Select your D1 database, then view: Metrics > Row Metrics.

### Definitions

1. Rows read measure how many rows a query reads (scans), regardless of the size of each row. For example, if you have a table with 5000 rows and run a `SELECT * FROM table` as a full table scan, this would count as 5,000 rows read. A query that filters on an [unindexed column](https://developers.cloudflare.com/d1/best-practices/use-indexes/) may return fewer rows to your Worker, but is still required to read (scan) more rows to determine which subset to return.
2. Rows written measure how many rows were written to D1 database. Write operations include `INSERT`, `UPDATE`, and `DELETE`. Each of these operations contribute towards rows written. A query that `INSERT` 10 rows into a `users` table would count as 10 rows written.
3. DDL operations (for example, `CREATE`, `ALTER`, and `DROP`) are used to define or modify the structure of a database. They may contribute to a mix of read rows and write rows. Ensure you are accurately tracking your usage through the available tools ([meta object](https://developers.cloudflare.com/d1/worker-api/return-object/), [GraphQL Analytics API](https://developers.cloudflare.com/d1/observability/metrics-analytics/#query-via-the-graphql-api), or the [Cloudflare dashboard ↗︎](https://dash.cloudflare.com/?to=/:account/workers/d1/)).
4. Row size or the number of columns in a row does not impact how rows are counted. A row that is 1 KB and a row that is 100 KB both count as one row.
5. Defining [indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/) on your table(s) reduces the number of rows read by a query when filtering on that indexed field. For example, if the `users` table has an index on a timestamp column `created_at`, the query `SELECT * FROM users WHERE created_at > ?1` would only need to read a subset of the table.
6. Indexes will add an additional written row when writes include the indexed column, as there are two rows written: one to the table itself, and one to the index. The performance benefit of an index and reduction in rows read will, in nearly all cases, offset this additional write.
7. Storage is based on gigabytes stored per month, and is based on the sum of all databases in your account. Tables and indexes both count towards storage consumed.
8. Free limits reset daily at 00:00 UTC. Monthly included limits reset based on your monthly subscription renewal date, which is determined by the day you first subscribed.
9. There are no data transfer (egress) or throughput (bandwidth) charges for data accessed from D1.
10. [Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) does not charge extra for read replicas. You incur the same usage billing based on `rows_read` and `rows_written` by your queries.

## Frequently Asked Questions

Frequently asked questions related to D1 pricing:

### Will D1 always have a Free plan?

Yes, the [Workers Free plan](https://developers.cloudflare.com/workers/platform/pricing/#workers) will always include the ability to prototype and experiment with D1 for free.

### What happens if I exceed the daily limits on reads and writes, or the total storage limit, on the Free plan?

When your account hits the daily read and/or write limits, you will not be able to run queries against D1. D1 API will return errors to your client indicating that your daily limits have been exceeded. Once you have reached your included storage limit, you will need to delete unused databases or clean up stale data before you can insert new data, create or alter tables or create indexes and triggers.

Upgrading to the Workers Paid plan will remove these limits, typically within minutes.

### What happens if I exceed the monthly included reads, writes and/or storage on the paid tier?

You will be billed for the additional reads, writes and storage according to [D1's pricing metrics](https://developers.cloudflare.com/d1/platform/pricing/#billing-metrics).

### How can I estimate my (eventual) bill?

Every query returns a `meta` object that contains a total count of the rows read (`rows_read`) and rows written (`rows_written`) by that query. For example, a query that performs a full table scan (for instance, `SELECT * FROM users`) from a table with 5000 rows would return a `rows_read` value of `5000`:

```json
"meta": {
  "duration": 0.20472300052642825,
  "size_after": 45137920,
  "rows_read": 5000,
  "rows_written": 0
}
```

These are also included in the D1 [Cloudflare dashboard ↗︎](https://dash.cloudflare.com) and the [analytics API](https://developers.cloudflare.com/d1/observability/metrics-analytics/), allowing you to attribute read and write volumes to specific databases, time periods, or both.

### Does D1 charge for data transfer / egress?

No.

### Does D1 charge additional for additional compute?

D1 itself does not charge for additional compute. Workers querying D1 and computing results: for example, serializing results into JSON and/or running queries, are billed per [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#workers), in addition to your D1 specific usage.

### Do queries I run from the dashboard or Wrangler (the CLI) count as billable usage?

Yes, any queries you run against your database, including inserting (`INSERT`) existing data into a new database, table scans (`SELECT * FROM table`), or creating indexes count as either reads or writes.

### Can I use an index to reduce the number of rows read by a query?

Yes, you can use an index to reduce the number of rows read by a query. [Creating indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/) for your most queried tables and filtered columns reduces how much data is scanned and improves query performance at the same time. If you have a read-heavy workload (most common), this can be particularly advantageous. Writing to columns referenced in an index will add at least one (1) additional row written to account for updating the index, but this is typically offset by the reduction in rows read due to the benefits of an index.

### Does a freshly created database, and/or an empty table with no rows, contribute to my storage?

Yes, although minimal. An empty table consumes at least a few kilobytes, based on the number of columns (table width) in the table. An empty database consumes approximately 12 KB of storage.

Was this helpful?

YesNo

## On this page

[![](https://developers.cloudflare.com/_astro/logo.te5VL_aD.svg)Docs](https://developers.cloudflare.com/)

```json
{"@context":"https://schema.org","@type":"TechArticle","@id":"https://developers.cloudflare.com/d1/platform/pricing/#page","headline":"Pricing","description":"D1 pricing based on rows read, rows written, and storage with scale-to-zero billing.","url":"https://developers.cloudflare.com/d1/platform/pricing/","inLanguage":"en","image":"https://developers.cloudflare.com/d1/platform/pricing/og.png?v=69a8a81ee033787f","dateModified":"2026-04-21","publisher":{"@type":"Organization","name":"Cloudflare","description":"One platform for your apps, agents, and workforce. Build, secure, and scale without managing infrastructure","url":"https://www.cloudflare.com/","sameAs":["https://github.com/cloudflare","https://www.linkedin.com/company/cloudflare","https://x.com/cloudflare"],"logo":{"@type":"ImageObject","url":"https://developers.cloudflare.com/logo.svg"},"address":{"@type":"PostalAddress","streetAddress":"101 Townsend St","addressLocality":"San Francisco","addressRegion":"CA","postalCode":"94107","addressCountry":"US"},"contactPoint":[{"@type":"ContactPoint","contactType":"Customer Support","url":"https://support.cloudflare.com/","availableLanguage":["English"]},{"@type":"ContactPoint","contactType":"Sales","url":"https://www.cloudflare.com/contact/","availableLanguage":["English"]}]},"isPartOf":{"@type":"WebSite","@id":"https://developers.cloudflare.com/#website","name":"Cloudflare Docs","url":"https://developers.cloudflare.com/"}}
```
