// push.test.js: у require('./push') додайте RULES_D0 (і PUSH_D0 на рівні 4)
test('правила D0 збігаються з client/domain.js', async () => {
  const { D0 } = await import('./client/domain.js');
  for (const [metric, r] of RULES_D0) {
    const m = D0.metrics[metric];
    assert.ok(m?.rule, `${metric}: у domain.js правила немає`);
    assert.equal(r.op, m.rule.direction === 'below' ? 'lt' : 'gt');
    assert.equal(r.warn, m.rule.warn, `${metric}.warn`);
    assert.equal(r.crit, m.rule.crit, `${metric}.crit`);
    assert.equal(r.label, m.label, `${metric}.label`);
    assert.equal(r.unit, m.unit, `${metric}.unit`);
    assert.equal(r.decimals, m.decimals, `${metric}.decimals`);
  }
  for (const [metric, m] of Object.entries(D0.metrics)) {
    if (m.rule) assert.ok(RULES_D0.has(metric), `${metric}: правила немає`);
  }
});
