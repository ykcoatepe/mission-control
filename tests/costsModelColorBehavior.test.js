const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const costsPath = path.join(__dirname, '..', 'frontend', 'src', 'pages', 'Costs.tsx')
const costsSource = fs.readFileSync(costsPath, 'utf8')

test('Costs keeps one recyclable color assignment pool for every model view', () => {
  assert.match(costsSource, /assignModelColors/)
  assert.match(costsSource, /modelColorState\.assignments/)
  assert.match(costsSource, /setModelColorState/)
  assert.match(costsSource, /assignedModelColor\(modelColors, model\)/)
  assert.doesNotMatch(costsSource, /getModelColor\(/)
  assert.doesNotMatch(costsSource, /previousModelColors\.current/)
})

test('canonical spend buckets preserve the pooled raw-model color', () => {
  assert.match(costsSource, /color: assignedModelColor\(modelColors, rawName \|\| name\)/)
  assert.doesNotMatch(costsSource, /current\.color = assignedModelColor\(modelColors, name\)/)
})

test('period transitions retain ledger assignments while replacement data loads', () => {
  assert.doesNotMatch(costsSource, /placeholderData:/)
  assert.match(costsSource, /const modelColorsRefreshing =\s*costsQuery\.isPending \|\|\s*tokenData\?\.source === 'sessions\.fast_fallback' \|\|\s*!!tokenData\?\.meta\?\.refreshing/)
  assert.match(costsSource, /if \(!modelColorsRefreshing && modelColorState\.activeKey !== activeModelKey\)/)
})

test('sessions without a model reuse their assigned fallback-name color', () => {
  assert.match(costsSource, /color: assignedModelColor\(modelColors, s\.model \|\| s\.displayName \|\| 'Unknown'\)/)
  assert.doesNotMatch(costsSource, /assignedModelColor\(modelColors, s\.model \|\| ''\)/)
})

test('reasoning metrics never reserve model colors', () => {
  assert.doesNotMatch(costsSource, /\/_\(tokens\|input\|output\|cacheRead\|/)
  assert.equal((costsSource.match(/\/_\(tokens\|input\|output\|reasoning\|cacheRead/g) || []).length, 3)
})
