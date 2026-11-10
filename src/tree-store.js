/**
 * CONTEXTO: TREES E SNAPSHOTS
 *
 * Um blob guarda somente os bytes de um arquivo. Uma tree representa um
 * diretório e associa cada nome imediato ao hash de um blob ou de outra tree.
 * Ao conectar trees recursivamente, a tree raiz descreve todos os caminhos do
 * snapshot preparado no index, sem incluir alterações posteriores na pasta.
 *
 * O conteúdo de cada tree do NIT é JSON UTF-8 no formato
 * {"version":1,"entries":[{"name":"a.js","type":"blob","hash":"..."}]}.
 * Uma entrada de subdiretório usa o tipo "tree". As entradas são ordenadas por
 * nome usando a ordem de strings do JavaScript, sem depender do locale; objetos
 * equivalentes têm os mesmos bytes e o mesmo hash. O JSON é uma simplificação
 * didática e NÃO é o formato binário de tree do Git: seus hashes não coincidem.
 *
 * O index já aponta para blobs criados por add; aqui reutilizamos esses objetos
 * e criamos as trees de baixo para cima. Um index vazio produz uma tree raiz
 * vazia. Na leitura, verificamos as referências e reconstruímos caminhos e hashes
 * sem escrever arquivos na árvore de trabalho: isso é responsabilidade do checkout.
 */

import { TextDecoder } from 'node:util'
import { readIndex } from './index-store.js'
import { readObject, writeObject } from './object-store.js'

const hashPattern = /^[0-9a-f]{40}$/

/** Confere se uma entrada representa um único nome seguro de arquivo ou pasta. */
function isValidName(name) {
  // Componentes especiais, separadores e NUL não podem formar caminhos válidos.
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  )
}

/** Constrói e grava recursivamente uma tree para cada diretório do snapshot. */
function writeDirectory(root, directory) {
  // 1. Ordena nomes de forma determinística e resolve subdiretórios primeiro.
  const entries = []
  for (const name of [...directory.keys()].sort()) {
    const child = directory.get(name)
    const type = child instanceof Map ? 'tree' : 'blob'
    const hash = type === 'tree' ? writeDirectory(root, child) : child
    entries.push({ name, type, hash })
  }

  // 2. Serializa o conteúdo em UTF-8 e o grava como objeto do tipo tree.
  const content = Buffer.from(JSON.stringify({ version: 1, entries }), 'utf8')
  return writeObject(root, 'tree', content)
}

/** Transforma o index persistido em trees e retorna o hash da tree raiz. */
export function writeTreeFromIndex(root) {
  // 1. Lê o index validado; ele contém caminhos relativos associados a blobs.
  return writeTreeFromSnapshot(root, readIndex(root))
}

/** Constrói trees para um mapa de caminhos e blobs, como o resultado do merge. */
export function writeTreeFromSnapshot(root, index) {
  // 1. Cria a estrutura em memória antes de gravar as trees.
  const directory = new Map()

  for (const [path, hash] of index) {
    // 2. Confere que cada referência existe e realmente aponta para um blob.
    const object = readObject(root, hash)
    if (object.type !== 'blob')
      throw new Error(`Index entry is not a blob: ${path}`)

    // 3. Separa os componentes para montar diretórios intermediários em memória.
    const parts = path.split('/')
    if (parts.some((part) => !isValidName(part)) || parts[0] === '.nit')
      throw new Error(`Invalid snapshot path: ${path}`)
    let current = directory

    for (const part of parts.slice(0, -1)) {
      if (!current.has(part)) current.set(part, new Map())
      current = current.get(part)
      if (!(current instanceof Map))
        throw new Error(`Snapshot path conflict: ${path}`)
    }

    if (current.has(parts.at(-1)))
      throw new Error(`Snapshot path conflict: ${path}`)
    current.set(parts.at(-1), hash)
  }

  // 4. Grava as trees de baixo para cima, inclusive uma raiz para index vazio.
  return writeDirectory(root, directory)
}

/** Interpreta e valida a lista de entradas de um objeto tree. */
function parseTree(content) {
  // 1. Rejeita UTF-8 inválido e JSON malformado, sem substituir bytes inválidos.
  let tree
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
    tree = JSON.parse(text)
  } catch (error) {
    throw new Error('Invalid tree: malformed UTF-8 or JSON.', { cause: error })
  }

  // 2. Aceita apenas a versão documentada e uma lista de entradas.
  if (
    !tree ||
    typeof tree !== 'object' ||
    Array.isArray(tree) ||
    tree.version !== 1 ||
    !Array.isArray(tree.entries)
  ) {
    throw new Error('Invalid tree: unsupported format or version.')
  }

  // 3. Valida nomes, tipos e hashes; nomes devem ser únicos e ordenados.
  let previous = null

  for (const entry of tree.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !isValidName(entry.name) ||
      !['blob', 'tree'].includes(entry.type) ||
      typeof entry.hash !== 'string' ||
      !hashPattern.test(entry.hash)
    ) {
      throw new Error('Invalid tree entry.')
    }

    if (previous !== null && previous >= entry.name)
      throw new Error('Invalid tree: entries must have unique, ordered names.')

    previous = entry.name
  }

  return tree.entries
}

/** Lê uma tree raiz e reconstrói um mapa de caminhos relativos para blobs. */
export function readTree(root, hash) {
  const files = new Map()
  const ancestors = new Set()

  /** Percorre uma tree e seus filhos, verificando os tipos de cada referência. */
  function visit(treeHash, prefix) {
    // 1. Evita ciclos na cadeia atual sem impedir reutilização de subtrees.
    if (ancestors.has(treeHash))
      throw new Error(`Invalid tree cycle: ${treeHash}`)

    ancestors.add(treeHash)

    try {
      // 2. O hash solicitado precisa existir e identificar um objeto tree.
      const tree = readObject(root, treeHash)
      if (tree.type !== 'tree')
        throw new Error(`Expected tree object: ${treeHash}`)

      // 3. Verifica cada filho antes de registrar arquivos ou descer em pastas.
      for (const entry of parseTree(tree.content)) {
        if (!prefix && entry.name === '.nit')
          throw new Error('Invalid tree: .nit is reserved at the root.')

        const path = prefix ? `${prefix}/${entry.name}` : entry.name

        if (entry.type === 'tree') {
          visit(entry.hash, path)
        } else {
          const object = readObject(root, entry.hash)

          if (object.type !== 'blob')
            throw new Error(`Expected blob object: ${entry.hash}`)

          files.set(path, entry.hash)
        }
      }
    } finally {
      // 4. Libera o ancestral após a visita para permitir árvores compartilhadas.
      ancestors.delete(treeHash)
    }
  }

  // A leitura não altera arquivos: o resultado é usado pelo checkout.
  visit(hash, '')
  return files
}
