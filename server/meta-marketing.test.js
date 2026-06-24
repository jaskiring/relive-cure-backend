import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCampaignLeadAnalytics, computeRecommendations } from './meta-marketing.js';

const baseFunnel = {
  total: 100,
  matched: 80,
  hot: 12,
  consulted: 20,
  booked: 8,
  won: 6,
  lost: 25,
  pending: 20,
};

const baseBreakdowns = {
  byStage: { captured: 20, matched: 10, contacted: 15, consulted: 20, booked: 8, done: 6, lost: 25 },
  byIntent: { HOT: { count: 12, surgeries: 4 }, WARM: { count: 40, surgeries: 2 }, COLD: { count: 20, surgeries: 0 }, Unknown: { count: 28, surgeries: 0 } },
  byCity: [{ city: 'Gurugram', count: 60, surgeries: 4 }, { city: 'Delhi', count: 25, surgeries: 2 }],
  byAd: [{ ad_id: 'ad1', ad_name: 'LASIK reel', count: 70, surgeries: 5 }, { ad_id: 'ad2', ad_name: 'Offer static', count: 30, surgeries: 1 }],
  byPlatform: [{ platform: 'instagram', count: 85, surgeries: 5 }, { platform: 'facebook', count: 15, surgeries: 1 }],
  byInsurance: [{ value: 'Yes', count: 30, surgeries: 3 }, { value: 'No', count: 50, surgeries: 2 }],
  refrensSla: { onTime: 40, breached: 22, dnp: 18 },
  refrensAssignee: [{ assignee: 'NISHIKANT', count: 50, surgeries: 4 }, { assignee: 'Khushi tomar', count: 20, surgeries: 1 }],
  intentByStage: { HOT: { lost: 3 }, WARM: { lost: 12 }, COLD: { lost: 10 } },
  timeline: Array.from({ length: 30 }, (_, i) => ({
    date: `2026-05-${String(i + 1).padStart(2, '0')}`,
    count: i >= 23 ? 8 : i >= 16 ? 4 : 6,
  })),
};

const baseBench = {
  matchRate: 0.75,
  surgeryRate: 0.05,
  hotPct: 0.10,
  cpl: 180,
  costPerSurgery: 4500,
};

test('computeCampaignLeadAnalytics returns benchmark comparisons and funnel steps', () => {
  const analytics = computeCampaignLeadAnalytics({
    kpis30: { spend: 18000, leads: 100, cpl: 180, frequency: 2.1 },
    kpis7: { cpl: 170 },
    wow: { cpl: -8 },
    breakdowns: baseBreakdowns,
    funnel: baseFunnel,
    accountBenchmark: baseBench,
  });

  assert.ok(Array.isArray(analytics.benchmarkComparisons));
  assert.ok(analytics.benchmarkComparisons.some((r) => r.key === 'matchRate'));
  assert.equal(analytics.funnelSteps.length, 6);
  assert.ok(analytics.bottleneck);
  assert.equal(analytics.velocity.last7, 56);
  assert.equal(analytics.velocity.prior7, 28);
  assert.ok(analytics.insights.length > 0);
  assert.ok(analytics.adEfficiency.length > 0);
});

test('computeCampaignLeadAnalytics flags spend without leads', () => {
  const analytics = computeCampaignLeadAnalytics({
    kpis30: { spend: 5000, leads: 0 },
    breakdowns: null,
    funnel: { total: 0, matched: 0, hot: 0, won: 0, pending: 0 },
    accountBenchmark: baseBench,
  });
  assert.ok(analytics.insights.some((i) => /Spend without attributed leads/i.test(i.title)));
});

test('computeRecommendations adds SLA and velocity suggestions', () => {
  const recs = computeRecommendations({
    kpis30: { spend: 18000, leads: 100, cpl: 180, frequency: 2.5 },
    kpis7: { spend: 4000, leads: 20, cpl: 200 },
    wow: { cpl: 25 },
    breakdowns: baseBreakdowns,
    funnel: baseFunnel,
    accountBenchmark: baseBench,
    campaign: { name: 'Test campaign' },
  });

  assert.ok(recs.some((r) => /SLA breach/i.test(r.title)));
  assert.ok(recs.some((r) => /Lead capture accelerating/i.test(r.title) || /Lead capture slowing/i.test(r.title)));
  assert.ok(recs.some((r) => /unmatched backlog/i.test(r.title)));
});
