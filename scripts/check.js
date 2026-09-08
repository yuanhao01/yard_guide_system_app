const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const projectRoot = path.resolve(__dirname, '..')
const miniprogramRoot = path.join(projectRoot, 'miniprogram')
const ignoredDirectories = new Set([
  'image', 'miniprogram_npm', 'packageAPI', 'packageCloud',
  'packageComponent', 'packageExtend', 'page'
])
const errors = []

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      visit(file)
    } else if (entry.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      if (result.status !== 0) errors.push(result.stderr.trim())
    } else if (entry.name.endsWith('.json')) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (error) {
        errors.push(`${file}: ${error.message}`)
      }
    }
  }
}

visit(miniprogramRoot)
JSON.parse(fs.readFileSync(path.join(projectRoot, 'project.config.json'), 'utf8'))

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log('小程序 JavaScript 与 JSON 静态检查通过。')
