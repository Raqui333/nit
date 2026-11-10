/**
 * CONTEXTO: MERGE DE TRÊS VIAS
 *
 * Merge compara três snapshots: o ancestral comum (base), a branch atual e a
 * branch recebida. Para cada caminho, uma mudança feita em apenas um lado é
 * aceita; mudanças idênticas também. Mudanças incompatíveis, incluindo remover
 * de um lado e alterar do outro, são conflitos e abortam sem alterar arquivos.
 *
 * Se a origem já é ancestral da atual, não há nada a fazer. Se a atual é
 * ancestral da origem, um fast-forward move a ref sem criar commit. Caso as
 * branches tenham divergido, um novo commit aponta para dois pais: primeiro o
 * commit atual e depois o recebido. O log continua seguindo apenas o primeiro.
 *
 * Quando há mais de um ancestral comum, escolhemos o de menor soma das menores
 * distâncias aos dois commits; em empate, vence o menor hash em ordem lexical.
 * É uma regra simplificada e determinística, não o algoritmo completo do Git.
 * A aplicação compartilha as proteções e os limites de recuperação do checkout.
 */

import { applyMergeCommit, assertCleanWorktree } from './checkout.js'
import { readCommit } from './commit-store.js'
import { writeObject } from './object-store.js'
import { readBranch, readHead } from './ref-store.js'
import { readTree, writeTreeFromSnapshot } from './tree-store.js'

/** Percorre todos os pais e registra a menor distância de cada ancestral. */
function ancestorDistances(root, start) {
  // A busca em largura considera também o segundo pai de merges anteriores.
  const distances = new Map([[start, 0]])
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    const hash = queue[i]
    const commit = readCommit(root, hash)
    for (const parent of commit.parents) {
      if (!distances.has(parent)) {
        distances.set(parent, distances.get(hash) + 1)
        queue.push(parent)
      }
    }
  }
  return distances
}

/** Escolhe um ancestral comum por distância total e depois por hash. */
function findMergeBase(ours, theirs) {
  // Ordenar também o desempate torna a escolha independente da ordem de visita.
  const common = [...ours.keys()].filter((hash) => theirs.has(hash))
  common.sort(
    (a, b) =>
      ours.get(a) + theirs.get(a) - ours.get(b) - theirs.get(b) ||
      (a < b ? -1 : a > b ? 1 : 0),
  )
  if (!common.length)
    throw new Error('Cannot merge histories without a common ancestor.')
  return common[0]
}

/** Combina os três mapas de caminhos e retorna snapshot ou caminhos conflitantes. */
function mergeSnapshots(base, ours, theirs) {
  // 1. Compara cada caminho usando undefined para representar ausência.
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])
  const result = new Map()
  const conflicts = new Set()

  for (const path of paths) {
    const original = base.get(path)
    const current = ours.get(path)
    const incoming = theirs.get(path)

    let selected

    if (current === incoming)
      selected = current
    else if (current === original)
      selected = incoming
    else if (incoming === original)
      selected = current
    else {
      conflicts.add(path)
      continue
    }

    if (selected !== undefined) result.set(path, selected)
  }

  // 2. Um caminho não pode ser arquivo e ancestral de outro ao mesmo tempo.
  for (const path of result.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      if (result.has(parent)) {
        conflicts.add(parent)
        conflicts.add(path)
      }
    }
  }

  if (conflicts.size) {
    throw new Error(
      `Merge conflicts:\n${[...conflicts]
        .sort()
        .map((path) => `  ${path}`)
        .join('\n')}`,
    )
  }

  return result
}

/** Integra uma branch na branch atual ou informa que já está integrada. */
export function mergeBranch(root, name, author = process.env.NIT_AUTHOR) {
  // 1. Exige duas branches com commits e valida index e arquivos antes de agir.
  const head = readHead(root)
  if (!head.branch) throw new Error('Cannot merge with detached HEAD.')
  if (!head.hash) throw new Error('Cannot merge before the first commit.')

  const source = readBranch(root, name)
  if (!source.hash) throw new Error('Cannot merge a branch without commits.')

  const ours = ancestorDistances(root, head.hash)
  const theirs = ancestorDistances(root, source.hash)

  assertCleanWorktree(root, head.hash)

  // 2. Histórico já integrado é no-op; fast-forward não precisa criar commit.
  if (ours.has(source.hash)) return { kind: 'up-to-date', hash: head.hash }

  if (theirs.has(head.hash)) {
    applyMergeCommit(root, source.hash, head, source)
    return { kind: 'fast-forward', hash: source.hash }
  }

  // 3. Históricos divergentes exigem ancestral, identidade e comparação por caminho.
  const baseHash = findMergeBase(ours, theirs)
  const base = readTree(root, readCommit(root, baseHash).tree)
  const current = readTree(root, readCommit(root, head.hash).tree)
  const incoming = readTree(root, readCommit(root, source.hash).tree)
  const merged = mergeSnapshots(base, current, incoming)

  if (typeof author !== 'string' || !author.trim() || /[\r\n\0]/.test(author)) {
    throw new Error(
      'Set NIT_AUTHOR to a non-empty, single-line author identity.',
    )
  }

  // 4. Grava tree e commit imutáveis antes de aplicar arquivos, index e ref.
  const tree = writeTreeFromSnapshot(root, merged)

  const commit = {
    version: 1,
    tree,
    parents: [head.hash, source.hash],
    author: author.trim(),
    date: new Date().toISOString(),
    message: `Merge branch '${name}'`,
  }

  const hash = writeObject(
    root,
    'commit',
    Buffer.from(JSON.stringify(commit), 'utf8'),
  )

  applyMergeCommit(root, hash, head, source)

  return { kind: 'merge', hash }
}
