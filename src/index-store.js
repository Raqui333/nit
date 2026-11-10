/**
 * CONTEXTO: INDEX E ÁREA DE PREPARAÇÃO
 *
 * O index é o snapshot preparado para o próximo commit, separado dos arquivos
 * que a pessoa continua editando. Ao executar add, o NIT grava os bytes atuais
 * como um blob e associa o caminho ao hash desse blob. Alterações posteriores
 * no arquivo não modificam a entrada preparada até outro add ser executado.
 *
 * Nesta etapa, .nit/index é um JSON próprio do NIT, não o index binário do Git:
 * { "version": 1, "entries": [{ "path": "src/a.js", "hash": "..." }] }.
 * Os caminhos são relativos à raiz e usam /; as entradas são ordenadas pelo
 * caminho para produzir a mesma representação independentemente da ordem de add.
 * Sem arquivo de index, o snapshot preparado está vazio. Remover uma entrada
 * prepara sua ausência; blobs antigos continuam na object store.
 *
 * A publicação usa arquivo temporário e rename para evitar um index parcialmente
 * escrito. Esta versão não implementa bloqueio entre processos nem garante
 * durabilidade em falhas de energia; não execute operações simultâneas no index.
 */

import {
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

import { randomBytes } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { resolveWorktreeFile } from './repository.js'
import { writeObject } from './object-store.js'

const hashPattern = /^[0-9a-f]{40}$/

/** Verifica se um caminho serializado é relativo, canônico e fora de .nit. */
function isValidIndexPath(path) {
  // Um formato com / e sem componentes especiais evita ambiguidades no index.
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..') &&
    path.split('/')[0] !== '.nit'
  )
}

/** Lê o snapshot preparado e rejeita estruturas inválidas em vez de apagá-las. */
export function readIndex(root) {
  // 1. Um index ainda não criado representa um snapshot vazio.
  let data
  try {
    data = readFileSync(join(root, '.nit', 'index'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw error
  }

  // 2. Interpreta a versão e a lista de entradas do formato próprio do NIT.
  let index
  try {
    index = JSON.parse(data)
  } catch (error) {
    throw new Error('Invalid index: malformed JSON.', { cause: error })
  }

  if (
    !index ||
    typeof index !== 'object' ||
    Array.isArray(index) ||
    index.version !== 1 ||
    !Array.isArray(index.entries)
  ) {
    throw new Error('Invalid index: unsupported format or version.')
  }

  // 3. Garante caminhos e hashes válidos, sem duplicatas nem colisões de tipo.
  const entries = new Map()
  for (const entry of index.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !isValidIndexPath(entry.path) ||
      typeof entry.hash !== 'string' ||
      !hashPattern.test(entry.hash) ||
      entries.has(entry.path)
    ) {
      throw new Error('Invalid index entry.')
    }
    entries.set(entry.path, entry.hash)
  }

  for (const path of entries.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (entries.has(parts.slice(0, i).join('/')))
        throw new Error('Invalid index: file and directory paths conflict.')
    }
  }

  return entries
}

/** Grava as entradas ordenadas e publica o novo index de uma só vez. */
export function writeIndex(root, entries) {
  // 1. Ordena por caminho sem depender do locale e monta o JSON versionado.
  const paths = [...entries.keys()].sort()
  const index = {
    version: 1,
    entries: paths.map((path) => ({ path, hash: entries.get(path) })),
  }
  const data = `${JSON.stringify(index, null, 2)}\n`
  const directory = join(root, '.nit')
  const temporary = join(
    directory,
    `index-tmp-${randomBytes(16).toString('hex')}`,
  )

  let created = false

  // 2. Grava em um arquivo exclusivo e só então substitui o index completo.
  try {
    writeFileSync(temporary, data, { flag: 'wx' })
    created = true

    renameSync(temporary, join(directory, 'index'))
    created = false
  } finally {
    // 3. Se a publicação falhar, remove apenas o temporário criado por nós.
    if (created) unlinkSync(temporary)
  }
}

/** Prepara um arquivo ou registra a remoção de uma entrada já preparada. */
export function addFile(root, input, directory = process.cwd()) {
  // 1. Valida o caminho, inclusive ancestrais existentes, sem seguir links.
  const absolute = resolveWorktreeFile(root, input, directory, {
    allowMissing: true,
  })

  const path = relative(root, absolute).split(sep).join('/')

  if (!isValidIndexPath(path))
    throw new Error('Invalid index path.')

  const entries = readIndex(root)

  // 2. Um arquivo ausente só pode representar remoção se já estiver no index.
  let info

  try {
    info = lstatSync(absolute)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error

    if (!entries.has(path))
      throw new Error(`File not found in working tree or index: ${path}`)

    entries.delete(path)
    writeIndex(root, entries)

    return { path, removed: true }
  }

  if (!info.isFile()) throw new Error('Expected a regular file.')

  // 3. Não permite que um arquivo preparado seja também diretório de outro.
  for (const existing of entries.keys()) {
    if (existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`)) {
      throw new Error(`Index path conflicts with existing entry: ${existing}`)
    }
  }

  // 4. Guarda os bytes atuais como blob e associa seu hash ao caminho.
  const content = readFileSync(absolute)
  const hash = writeObject(root, 'blob', content)

  entries.set(path, hash)
  writeIndex(root, entries)

  return { path, hash, removed: false }
}
