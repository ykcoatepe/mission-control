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
