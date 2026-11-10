/**
 * CONTEXTO: CHECKOUT E SEGURANÇA DOS ARQUIVOS
 *
 * Checkout materializa o snapshot de um commit na árvore de trabalho, substitui
 * o index por esse snapshot e conecta HEAD à branch escolhida ou o destaca em
 * um hash. A branch anterior não muda. A tree fornece caminhos e hashes.
 *
 * Antes de escrever, comparamos HEAD, index e arquivos rastreados, lemos todos
 * os objetos necessários e planejamos colisões com arquivos não rastreados.
 * Alterações locais, links simbólicos e obstáculos que possam ser sobrescritos
 * causam erro. Diretórios só são removidos se estiverem vazios após retirar os
 * arquivos rastreados; conteúdo não rastreado nunca é removido intencionalmente.
 *
 * Durante a aplicação guardamos instruções de desfazimento em memória. Se uma
 * operação falhar, tentamos restaurar arquivos e index; falhas na restauração
 * são informadas. Isso não é uma transação durável: interrupção do processo,
 * queda de energia, falhas de recuperação ou alterações concorrentes podem exigir
 * intervenção manual. Não execute checkout simultaneamente com outras operações.
 */

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

import { join } from 'node:path'
import { readCommit } from './commit-store.js'
import { readIndex, writeIndex } from './index-store.js'
import { hashObject, readObject, serializeObject } from './object-store.js'
import {
  attachHead,
  detachHead,
  readBranch,
  readHead,
  updateHead,
} from './ref-store.js'
import { readTree } from './tree-store.js'

/** Compara mapas de caminhos e hashes sem depender da ordem de inserção. */
function sameSnapshot(first, second) {
  // Tamanhos e todos os pares precisam coincidir para não haver alterações no index.
  return (
    first.size === second.size &&
    [...first].every(([path, hash]) => second.get(path) === hash)
  )
}

/** Lê informações de um caminho sem seguir links; ausência não é um erro. */
function statIfExists(path) {
  // ENOENT indica um caminho livre; erros de permissão e outros são propagados.
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Lista os diretórios implícitos nos caminhos rastreados. */
function trackedDirectories(files) {
  // Cada prefixo anterior ao nome do arquivo representa um diretório da tree.
  const directories = new Set()
  for (const path of files.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++)
      directories.add(parts.slice(0, i).join('/'))
  }
  return directories
}

/** Planeja o checkout sem modificar arquivos ou metadados. */
function planCheckout(root, hash) {
  // 1. Valida o commit de destino e lê integralmente sua tree e a tree atual.
  const target = hash ? readTree(root, readCommit(root, hash).tree) : new Map()
  const head = readHead(root)

  const current = head.hash
    ? readTree(root, readCommit(root, head.hash).tree)
    : new Map()

  const index = readIndex(root)

  if (!sameSnapshot(current, index))
    throw new Error('Cannot checkout: index has staged changes.')

  // 2. Confere todos os arquivos rastreados e guarda bytes e permissões para recuperação.
  const originals = new Map()
  for (const [path, expectedHash] of current) {
    const parts = path.split('/')
    let location = root
    for (const [i, part] of parts.entries()) {
      location = join(location, part)
      const info = statIfExists(location)
      if (
        !info ||
        info.isSymbolicLink() ||
        (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())
      ) {
        throw new Error(
          `Cannot checkout: tracked path is missing or changed: ${path}`,
        )
      }
      if (i === parts.length - 1) {
        const content = readFileSync(location)
        if (hashObject(serializeObject('blob', content)) !== expectedHash)
          throw new Error(
            `Cannot checkout: tracked file has local changes: ${path}`,
          )
        originals.set(path, { content, mode: info.mode & 0o777 })
      }
    }
  }

  // 3. Carrega todos os blobs de destino antes de qualquer alteração no disco.
  const contents = new Map()
  for (const [path, blobHash] of target) {
    const blob = readObject(root, blobHash)
    if (blob.type !== 'blob')
      throw new Error(`Expected blob object: ${blobHash}`)
    contents.set(path, blob.content)
  }

  const removals = [...current.keys()].filter(
    (path) => current.get(path) !== target.get(path),
  )

  const writes = [...target.keys()].filter(
    (path) => current.get(path) !== target.get(path),
  )

  const directories = trackedDirectories(current)
  const removeDirectories = new Set()

  /** Examina uma pasta que precisa virar arquivo, sem atravessar links. */
  function inspectDirectory(path) {
    // Qualquer diretório ou conteúdo não rastreado impede a substituição.
    if (!directories.has(path))
      throw new Error(`Cannot checkout: untracked directory obstructs ${path}`)

    for (const name of readdirSync(join(root, ...path.split('/')))) {
      const child = `${path}/${name}`
      const info = lstatSync(join(root, ...child.split('/')))

      if (info.isDirectory()) {
        inspectDirectory(child)
      } else if (
        !info.isFile() ||
        !current.has(child) ||
        !removals.includes(child)
      ) {
        throw new Error(`Cannot checkout: untracked path obstructs ${child}`)
      }
    }

    removeDirectories.add(path)
  }

  // 4. Identifica obstáculos também nos ancestrais e nas colisões pasta/arquivo.
  for (const path of writes) {
    const parts = path.split('/')

    let location = root
    let relative = ''

    for (const [i, part] of parts.entries()) {
      location = join(location, part)
      relative = relative ? `${relative}/${part}` : part

      const info = statIfExists(location)

      if (!info) break

      if (info.isSymbolicLink())
        throw new Error(`Cannot checkout: symbolic link obstructs ${relative}`)

      if (i < parts.length - 1) {
        if (info.isDirectory()) continue
        if (info.isFile() && removals.includes(relative)) break
        throw new Error(`Cannot checkout: path obstructs ${relative}`)
      }

      if (info.isDirectory()) {
        inspectDirectory(relative)
      } else if (!info.isFile() || !current.has(relative)) {
        throw new Error(`Cannot checkout: untracked path obstructs ${relative}`)
      }
    }
  }

  return {
    head,
    index,
    current,
    target,
    contents,
    originals,
    removals,
    writes,
    removeDirectories: [...removeDirectories].sort(
      (a, b) => b.split('/').length - a.split('/').length,
    ),
  }
}

/** Aplica um snapshot e conecta ou destaca HEAD após a atualização dos arquivos. */
function applyCheckout(root, hash, branch = null, merge = null) {
  // 1. Nenhuma alteração ocorre enquanto o plano, objetos e colisões são validados.
  const plan = planCheckout(root, hash)
  if (
    merge &&
    (plan.head.hash !== merge.head.hash ||
      plan.head.branch !== merge.head.branch ||
      plan.head.target !== merge.head.target)
  ) {
    throw new Error('HEAD changed while preparing the merge.')
  }
  const undo = []
  const indexPath = join(root, '.nit', 'index')

  let indexExisted = true
  let originalIndex

  try {
    originalIndex = readFileSync(indexPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    indexExisted = false
  }

  try {
    // 2. Retira arquivos antigos e pastas rastreadas que precisam virar arquivos.
    for (const path of plan.removals) {
      const absolute = join(root, ...path.split('/'))
      const original = plan.originals.get(path)
      unlinkSync(absolute)
      undo.push(() =>
        writeFileSync(absolute, original.content, {
          flag: 'wx',
          mode: original.mode,
        }),
      )
    }

    for (const path of plan.removeDirectories) {
      const absolute = join(root, ...path.split('/'))
      const mode = lstatSync(absolute).mode & 0o777
      rmdirSync(absolute)
      undo.push(() => mkdirSync(absolute, { mode }))
    }

    // 3. Cria apenas diretórios ausentes e arquivos exclusivos do snapshot destino.
    for (const path of plan.writes) {
      const parts = path.split('/')
      let directory = root
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part)
        const info = statIfExists(directory)
        if (!info) {
          mkdirSync(directory)
          const created = directory
          undo.push(() => rmdirSync(created))
        } else if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error(
            `Checkout path changed during operation: ${directory}`,
          )
        }
      }

      const absolute = join(root, ...parts)
      const fd = openSync(absolute, 'wx')
      undo.push(() => unlinkSync(absolute))

      try {
        writeFileSync(fd, plan.contents.get(path))
      } finally {
        closeSync(fd)
      }
    }

    // 4. Atualiza o index somente depois dos arquivos e HEAD depois do index.
    writeIndex(root, plan.target)
    undo.push(() => {
      if (indexExisted) writeFileSync(indexPath, originalIndex)
      else unlinkSync(indexPath)
    })
    if (merge) {
      const source = readBranch(root, merge.source.name)
      if (source.hash !== merge.source.hash)
        throw new Error('Source branch changed while merging.')
      updateHead(root, plan.head, hash)
    } else if (branch) attachHead(root, plan.head, branch)
    else detachHead(root, plan.head, hash)
  } catch (error) {
    // 5. Desfaz em ordem inversa; informa explicitamente se alguma restauração falhar.
    const failures = []

    for (const restore of undo.reverse()) {
      try {
        restore()
      } catch (failure) {
        failures.push(failure.message)
      }
    }

    if (failures.length)
      throw new Error(
        `Checkout failed: ${error.message}. Recovery incomplete: ${failures.join('; ')}`,
        { cause: error },
      )

    throw new Error(`Checkout failed; changes restored: ${error.message}`, {
      cause: error,
    })
  }
  return hash
}

/** Restaura um commit identificado por hash e destaca HEAD. */
export function checkoutCommit(root, hash) {
  // Exige hash completo mesmo que uma branch inicial possa ter snapshot vazio.
  if (typeof hash !== 'string' || !/^[0-9a-f]{40}$/.test(hash))
    throw new Error('Invalid commit hash.')
  return applyCheckout(root, hash)
}

/** Restaura o snapshot de uma branch e conecta HEAD a ela. */
export function checkoutBranch(root, name) {
  // Resolve a ref antes de aplicar o mesmo planejamento seguro do checkout por hash.
  const branch = readBranch(root, name)
  applyCheckout(root, branch.hash, branch)
  return branch
}

/** Verifica index e arquivos atuais sem alterar o repositório. */
export function assertCleanWorktree(root, hash) {
  // Planejar o snapshot atual reutiliza as mesmas verificações do checkout.
  planCheckout(root, hash)
}

/** Aplica o snapshot de um commit e avança a branch atual após a aplicação. */
export function applyMergeCommit(root, hash, head, source) {
  // O plano reaplica as proteções e verifica as duas refs antes de publicá-las.
  return applyCheckout(root, hash, null, { head, source })
}
