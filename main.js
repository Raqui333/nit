#!/usr/bin/env node

import {
  findRepository,
  initRepository,
  resolveWorktreeFile,
} from './src/repository.js'

import {
  hashObject,
  readObject,
  serializeObject,
  writeObject,
} from './src/object-store.js'

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { addFile } from './src/index-store.js'
import { createCommit, readHistory } from './src/commit-store.js'
import { checkoutBranch, checkoutCommit } from './src/checkout.js'
import { createBranch } from './src/branch.js'
import { mergeBranch } from './src/merge.js'

import dotenv from 'dotenv'

// Os dois primeiros argumentos identificam o Node e este arquivo; os demais
// são os argumentos informados pelo usuário.
const args = process.argv.slice(2)
const command = args[0]

/** Lê a identidade ao lado de main.js sem substituir o ambiente atual. */
function readAuthor() {
  // 1. Resolve o .env relativo ao programa, independente do diretório atual.
  const settings = {}

  const result = dotenv.config({
    path: new URL('./.env', import.meta.url),
    processEnv: settings,
    quiet: true,
  })

  if (result.error && result.error.code !== 'ENOENT') {
    throw result.error
  }

  // 2. A identidade explícita no ambiente tem prioridade sobre o arquivo.
  return process.env.NIT_AUTHOR ?? settings.NIT_AUTHOR
}

function showHelp() {
  console.log(`NIT — Not Git, an educational version control system.

Usage:
  nit <command> [options] [arguments]
  nit -h | --help

Commands:
  init                         Initialize a repository in the current directory.
  add <file>                   Stage a file or its removal for the next commit.
  commit -m <message>          Commit the staged snapshot.
  log                          Show commit history following the first parent.
  branch <name>                Create a branch at the current commit.
  checkout <hash|branch>       Restore a commit or switch to a branch.
  merge <branch>               Merge a branch into the current branch.
  hash-object [-w] <file>      Print a blob hash; -w also stores the object.
  cat-file <hash>              Show an object's type, size and raw content.

Options:
  -h, --help                   Show this help message.
  -m, --message <message>      Set the commit message (commit only).
  -w, --write                  Store the blob (hash-object only).
  --                           Treat following arguments as positional values.

Configuration:
  Set NIT_AUTHOR in the environment or in .env next to the NIT main.js file.
  An environment value takes precedence. An author is required for commits
  and divergent merges that create a commit.

Examples:
  nit init
  nit add file.js
  nit commit -m "Add file"
  nit branch feature
  nit checkout feature
  nit merge main
  nit hash-object -w file.js

Use a complete commit hash for checkout; this leaves HEAD detached.
Checkout and merge refuse changes that could overwrite local work.
`)
}

/** Inicializa o repositório no diretório atual. */
function handleInit({ positionals }) {
  if (positionals.length !== 0) {
    throw new Error('Usage: nit init')
  }

  const result = initRepository()
  const action = result.existing
    ? 'NIT repository already initialized'
    : 'NIT repository initialized'

  console.log(`${action} in ${result.root}`)
}

/** Prepara um arquivo ou sua remoção no index. */
function handleAdd({ positionals }) {
  if (positionals.length !== 1) {
    throw new Error('Usage: nit add <file>')
  }

  const result = addFile(findRepository(), positionals[0])

  console.log(`${result.removed ? 'Removed' : 'Added'}: ${result.path}`)
}

/** Cria um commit com a mensagem e a identidade informadas. */
function handleCommit({ values, positionals }) {
  if (positionals.length !== 0 || values.message === undefined) {
    throw new Error('Usage: nit commit -m <message>')
  }

  const root = findRepository()
  const commit = createCommit(root, values.message, readAuthor())

  console.log(`Committed: ${commit.hash}`)
}

/** Apresenta o histórico percorrido pelo primeiro pai. */
function handleLog({ positionals }) {
  if (positionals.length !== 0) {
    throw new Error('Usage: nit log')
  }

  const history = readHistory(findRepository())

  if (history.length === 0) {
    console.log('No commits yet.')
  }

  for (const commit of history) {
    console.log(
      `commit ${commit.hash}\nAuthor: ${commit.author}\nDate:   ${commit.date}\n\n${commit.message
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')}\n`,
    )
  }
}

/** Cria uma branch sem trocar a posição atual. */
function handleBranch({ positionals }) {
  if (positionals.length !== 1) {
    throw new Error('Usage: nit branch <name>')
  }

  const branch = createBranch(findRepository(), positionals[0])

  console.log(`Created branch ${branch.name} at ${branch.hash}`)
}

/** Integra a branch informada e descreve o resultado. */
function handleMerge({ positionals }) {
  if (positionals.length !== 1) {
    throw new Error('Usage: nit merge <branch>')
  }

  const root = findRepository()
  const result = mergeBranch(root, positionals[0], readAuthor())

  if (result.kind === 'up-to-date') {
    console.log('Already up to date.')
  } else if (result.kind === 'fast-forward') {
    console.log(`Fast-forward: ${result.hash}`)
  } else {
    console.log(`Merge commit: ${result.hash}`)
  }
}

/** Restaura um commit por hash ou troca para uma branch. */
function handleCheckout({ positionals }) {
  if (positionals.length !== 1) {
    throw new Error('Usage: nit checkout <commit-hash|branch>')
  }

  const root = findRepository()

  if (/^[0-9a-f]{40}$/.test(positionals[0])) {
    const hash = checkoutCommit(root, positionals[0])

    console.log(`HEAD detached at ${hash}`)
  } else {
    const branch = checkoutBranch(root, positionals[0])

    console.log(`Switched to branch ${branch.name}`)
  }
}

/** Calcula o hash de um blob e, com -w, grava o objeto. */
function handleHashObject({ values, positionals }) {
  if (positionals.length !== 1) {
    throw new Error('Usage: nit hash-object [-w] <file>')
  }

  const root = values.write ? findRepository() : null

  const path = values.write
    ? resolveWorktreeFile(root, positionals[0])
    : positionals[0]

  const content = readFileSync(path)

  const hash = values.write
    ? writeObject(root, 'blob', content)
    : hashObject(serializeObject('blob', content))

  console.log(hash)
}

/** Apresenta metadados e bytes de um objeto pelo hash. */
function handleCatFile({ positionals }) {
  if (positionals.length !== 1) {
    throw new Error('Usage: nit cat-file <hash>')
  }

  const object = readObject(findRepository(), positionals[0])

  // O cabeçalho é texto; os bytes seguintes são escritos sem conversão.
  process.stdout.write(`type: ${object.type}\nsize: ${object.size}\n\n`)
  process.stdout.write(object.content)
}

// Cada comando define sua função e, quando necessário, as opções aceitas.
const commands = {
  init: handleInit,
  add: handleAdd,
  commit: handleCommit,
  log: handleLog,
  branch: handleBranch,
  merge: handleMerge,
  checkout: handleCheckout,
  'hash-object': handleHashObject,
  'cat-file': handleCatFile,
}

const options = {
  commit: {
    message: { type: 'string', short: 'm' },
  },
  'hash-object': {
    write: { type: 'boolean', short: 'w' },
  },
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  if (!command || ['--help', '-h'].includes(command)) {
    return showHelp()
  }

  const handler = Object.hasOwn(commands, command)
    ? commands[command]
    : undefined

  if (!handler) {
    throw new Error(`Unknown command: ${command}`)
  }

  const parsed = parseArgs({
    args,
    options: options[command] ?? {},
    allowPositionals: true,
    strict: true,
  })

  await handler(parsed)
}

main().catch((error) => {
  console.error(`Error: ${error.message}`)
  process.exitCode = 1
})
