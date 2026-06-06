import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  discoverOcdsDatasets,
  fetchOcdsPackage,
  findJsonResource,
  releaseToContracts,
  runRefreshSlice,
  upsertContractStaging,
  type OcdsMeta,
} from '@sigma/ingest';
import refreshSliceSql from '../../../scripts/refresh-slice.sql';

export interface Env {
  DB: D1Database;
  REFRESH: Workflow;
}

interface RefreshParams {
  /**
   * Operator backfill knob: limit to a single OCDS dataset URI (else the newest period is
   * discovered). Settable only via the CF dashboard / `wrangler workflows trigger`
   * (credential-gated); there is no public trigger.
   */
  datasetUri?: string;
}

// The on-platform daily refresh. Durable, individually-retried steps: discover the newest OCDS
// period → fetch it → upsert the contract staging → scoped re-derive of the touched slice +
// refresh its rollup/FTS rows (scripts/refresh-slice.sql). The full-rebuild normalize stays off
// this path; the Queue fan-out for the TR backfill is deferred. Raw archival is delegated to the
// external BG feeder (see docs/etl-pipeline.md).
export class RefreshWorkflow extends WorkflowEntrypoint<Env, RefreshParams> {
  override async run(
    event: WorkflowEvent<RefreshParams>,
    step: WorkflowStep,
  ): Promise<{ datasets: number; staged: number; derived: number }> {
    const params = event.payload ?? {};
    const fetchedAt = new Date().toISOString();

    // 1) Which OCDS dataset(s) to refresh.
    const datasets = await step
      .do('discover', async () => {
        const all = await discoverOcdsDatasets();
        const picked = params.datasetUri
          ? all.filter((d) => d.uri === params.datasetUri)
          : all.slice(0, 1);
        const out = [];
        for (const ds of picked) {
          const res = await findJsonResource(ds.uri);
          if (res)
            out.push({
              uri: ds.uri,
              resourceUri: res.uri,
              source: `ocds:${ds.year}:${ds.periodStart}`,
              year: ds.year,
            });
        }
        return out;
      })
      .catch((error) => {
        console.error(JSON.stringify({ level: 'error', event: 'etl_discovery_failed' }));
        throw error;
      });

    // 2) Per dataset: fetch + flatten + upsert staging (big payload stays inside the step; only the
    //    small {staged} count is persisted as the step result). No raw archival — the BG feeder
    //    owns that.
    let staged = 0;
    for (const ds of datasets) {
      const meta: OcdsMeta = {
        source: ds.source,
        datasetUri: ds.uri,
        resourceUri: ds.resourceUri,
        year: ds.year,
        fetchedAt,
      };
      const n = await step.do(`ingest:${ds.source}`, async () => {
        // Fetch first so the package-level publishedDate is in scope: releases that lack their
        // own `date` fall back to it (mirrors load-ocds.mjs), instead of regressing to NULL.
        const pkg = await fetchOcdsPackage(ds.resourceUri);
        meta.publishedDate = pkg.publishedDate;
        const releases = pkg.releases ?? [];
        const rows = releases.flatMap((rel) => releaseToContracts(rel, meta));
        return upsertContractStaging(this.env.DB, ds.source, rows);
      });
      staged += n;
    }

    if (staged === 0) {
      console.warn(JSON.stringify({ level: 'warn', event: 'etl_zero_ingest', fetchedAt }));
      return { datasets: datasets.length, staged: 0, derived: 0 };
    }

    // 3) Scoped re-derive + refresh the affected rollup/FTS rows.
    const derived = await step.do('derive-slice', async () =>
      runRefreshSlice(this.env.DB, refreshSliceSql),
    );

    return { datasets: datasets.length, staged, derived };
  }
}

export default {
  // Cron entrypoint: kick one durable refresh run (discovers the newest OCDS period itself).
  async scheduled(_controller, env): Promise<void> {
    const instance = await env.REFRESH.create();
    console.log(JSON.stringify({ level: 'info', event: 'etl_scheduled_refresh', id: instance.id }));
  },
} satisfies ExportedHandler<Env>;
