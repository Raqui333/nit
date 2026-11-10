/**
 * CONTEXTO: COMMITS E HISTÓRICO
 *
 * Um commit registra uma tree raiz, uma lista ordenada de commits pais, autor,
 * data e mensagem. A tree representa o snapshot preparado no index; os pais
 * ligam snapshots e formam o histórico. O primeiro commit não tem pai; commits
 * normais têm um; um merge commit tem dois pais.
 *
 * O NIT serializa esses campos em JSON UTF-8 compacto, versionado, com chaves
 * version, tree, parents, author, date e message nessa ordem. É um formato
 * próprio e não o formato binário/textual de commits do Git. Data é ISO 8601
 * em UTC. O autor vem de NIT_AUTHOR; se estiver vazio ou ausente, há erro.
 *
 * Ao commitar, gravamos primeiro a tree e o commit imutáveis e só então movemos
 * a referência. Uma falha pode deixar objetos sem referência, mas não deve fazer
 * a branch apontar para um commit parcialmente escrito. O log percorre apenas o
 * primeiro pai; outros pais de merges não são percorridos pelo log.
 */

import { TextDecoder } from 'node:util'
import { readObject, writeObject } from './object-store.js'
import { readHead, updateHead } from './ref-store.js'
import { writeTreeFromIndex } from './tree-store.js'

const hashPattern = /^[0-9a-f]{40}$/

/** Lê um commit e valida seu tipo, formato e metadados. */
export function readCommit(root, hash) {
  // 1. Lê o objeto pela store, que já verifica hash e integridade dos bytes.
  const object = readObject(root, hash)
  if (object.type !== 'commit')
    throw new Error(`Expected commit object: ${hash}`)

  // 2. Interpreta o JSON sem substituir sequências inválidas de UTF-8.
  let commit
  try {
    commit = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(object.content),
    )
  } catch (error) {
    throw new Error(`Invalid commit: ${hash}`, { cause: error })
  }

  // 3. Rejeita campos inválidos antes de usar o commit para navegar no histórico.
  if (
    !commit ||
    typeof commit !== 'object' ||
    Array.isArray(commit) ||
    commit.version !== 1 ||
    typeof commit.tree !== 'string' ||
    !hashPattern.test(commit.tree) ||
    !Array.isArray(commit.parents) ||
    !commit.parents.every(
      (parent) => typeof parent === 'string' && hashPattern.test(parent),
    ) ||
    typeof commit.author !== 'string' ||
    !commit.author.trim() ||
    /[\r\n\0]/.test(commit.author) ||
    typeof commit.message !== 'string' ||
    !commit.message.trim() ||
    typeof commit.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(commit.date) ||
    !Number.isFinite(Date.parse(commit.date)) ||
    new Date(commit.date).toISOString() !== commit.date
  ) {
    throw new Error(`Invalid commit fields: ${hash}`)
  }
  // 4. Devolve apenas os campos reconhecidos, sem propagar metadados extras.
  return {
    version: commit.version,
    tree: commit.tree,
    parents: commit.parents,
    author: commit.author,
    date: commit.date,
    message: commit.message,
  }
}

/** Cria um commit do index e avança a branch atual ou o HEAD destacado. */
export function createCommit(root, message, author = process.env.NIT_AUTHOR) {
  // 1. Exige mensagem e identidade explícitas antes de gravar qualquer objeto.
  if (typeof message !== 'string' || !message.trim())
    throw new Error('Commit message cannot be empty.')

  if (typeof author !== 'string' || !author.trim() || /[\r\n\0]/.test(author)) {
    throw new Error(
      'Set NIT_AUTHOR to a non-empty, single-line author identity.',
    )
  }

  const head = readHead(root)
  const parent = head.hash ? readCommit(root, head.hash) : null

  // 2. Cria a tree do index e impede commits posteriores sem mudança de snapshot.
  const tree = writeTreeFromIndex(root)
  if (parent && parent.tree === tree)
    throw new Error('Nothing to commit: index matches HEAD.')

  // 3. Serializa os metadados em ordem fixa e grava o objeto antes de mover HEAD.
  const commit = {
    version: 1,
    tree,
    parents: head.hash ? [head.hash] : [],
    author: author.trim(),
    date: new Date().toISOString(),
    message,
  }

  const hash = writeObject(
    root,
    'commit',
    Buffer.from(JSON.stringify(commit), 'utf8'),
  )

  // 4. Atualiza apenas a referência correspondente ao estado de HEAD observado.
  updateHead(root, head, hash)
  return { hash, ...commit }
}

/** Percorre commits do mais recente ao mais antigo pelo primeiro pai. */
export function readHistory(root) {
  // 1. Um HEAD sem commit representa um histórico vazio.
  let hash = readHead(root).hash

  const history = []
  const visited = new Set()

  // 2. Lê cada commit e acompanha somente o primeiro pai, detectando ciclos.
  while (hash) {
    if (visited.has(hash)) throw new Error(`Commit history cycle: ${hash}`)
    visited.add(hash)
    const commit = readCommit(root, hash)
    history.push({ hash, ...commit })
    hash = commit.parents[0] ?? null
  }

  return history
}
