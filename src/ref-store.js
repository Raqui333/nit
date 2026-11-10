/**
 * CONTEXTO: HEAD E REFERÊNCIAS
 *
 * Objetos são imutáveis, mas uma branch é uma referência que muda para apontar
 * ao commit mais recente. HEAD pode conter "ref: refs/heads/main", apontando
 * para uma branch, ou diretamente um hash, no chamado HEAD destacado. Antes do
 * primeiro commit, a referência da branch ainda não existe e não há hash.
 *
 * Os arquivos de referência contêm um hash completo seguido de quebra de linha.
 * São aceitos nomes de branch simples, sem subdiretórios. A main sem arquivo de
 * ref representa a branch inicial sem commit. Escrevemos
 * um temporário e usamos rename para evitar arquivos parcialmente escritos, mas
 * não há bloqueio entre processos nem garantia de durabilidade em falta de energia.
 */

import {
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

const hashPattern = /^[0-9a-f]{40}$/
const branchPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

/** Valida nomes simples e reserva hashes completos para checkout destacado. */
function validateBranchName(name) {
  // Não permitimos nomes que seriam confundidos com um hash no checkout.
  if (
    typeof name !== 'string' ||
    !branchPattern.test(name) ||
    hashPattern.test(name)
  ) {
    throw new Error(
      'Invalid branch name: use letters, digits, underscores or hyphens; full hashes are reserved.',
    )
  }
}

/** Verifica os diretórios que contêm referências sem seguir links simbólicos. */
function checkBranchDirectories(root) {
  // A estrutura precisa existir antes de qualquer leitura ou gravação de refs.
  for (const path of [
    join(root, '.nit', 'refs'),
    join(root, '.nit', 'refs', 'heads'),
  ]) {
    if (!lstatSync(path).isDirectory())
      throw new Error(`Invalid reference directory: ${path}`)
  }
}

/** Lê o hash de uma branch; somente main pode existir ainda sem commit. */
export function readBranch(root, name) {
  // 1. Valida o nome e a estrutura antes de construir o caminho da referência.
  validateBranchName(name)
  checkBranchDirectories(root)

  const target = join(root, '.nit', 'refs', 'heads', name)
  const content = readMetadata(target, true)

  // 2. A main ausente representa a branch inicial; outras devem ter referência.
  if (content === null) {
    if (name === 'main') return { name, hash: null }
    throw new Error(`Branch not found: ${name}`)
  }

  const hash = content.trimEnd()

  if (!hashPattern.test(hash))
    throw new Error(`Invalid branch reference: ${name}`)

  return { name, hash }
}

/** Cria uma ref de branch sem sobrescrever uma existente. */
export function createBranchReference(root, name, hash) {
  // 1. Garante nome seguro, hash completo e diretórios de refs válidos.
  validateBranchName(name)
  if (!hashPattern.test(hash)) throw new Error('Invalid commit hash.')

  checkBranchDirectories(root)
  if (name === 'main') throw new Error('Branch already exists: main')

  const directory = join(root, '.nit', 'refs', 'heads')
  const target = join(directory, name)

  const temporary = join(
    directory,
    `branch-tmp-${randomBytes(16).toString('hex')}`,
  )

  let created = false

  try {
    // 2. Escreve o conteúdo completo e publica com link exclusivo, sem substituir.
    writeFileSync(temporary, `${hash}\n`, { flag: 'wx' })

    created = true

    try {
      linkSync(temporary, target)
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(`Branch already exists: ${name}`)
      throw error
    }
  } finally {
    // 3. O link publicado permanece após remover o nome temporário.
    if (created) unlinkSync(temporary)
  }
}

/** Lê um arquivo de metadados regular, rejeitando links simbólicos. */
function readMetadata(path, allowMissing = false) {
  // 1. Verifica o próprio arquivo sem seguir links antes de ler seu conteúdo.
  try {
    if (!lstatSync(path).isFile())
      throw new Error(`Invalid reference file: ${path}`)
    return readFileSync(path, 'utf8')
  } catch (error) {
    // 2. Uma ref ausente é permitida somente para representar uma branch vazia.
    if (allowMissing && error.code === 'ENOENT')
      return null

    throw error
  }
}

/** Resolve HEAD para a referência atual e seu hash, ou para um HEAD destacado. */
export function readHead(root) {
  // 1. HEAD deve ser um hash completo ou uma referência simbólica reconhecida.
  const headPath = join(root, '.nit', 'HEAD')
  const head = readMetadata(headPath).trimEnd()

  if (hashPattern.test(head))
    return { hash: head, target: headPath, branch: null }

  const prefix = 'ref: refs/heads/'

  if (!head.startsWith(prefix)) throw new Error('Invalid HEAD.')

  const branch = head.slice(prefix.length)

  // 2. Resolve a branch; main pode ainda não ter seu primeiro commit.
  const reference = readBranch(root, branch)
  const target = join(root, '.nit', 'refs', 'heads', branch)

  return { hash: reference.hash, target, branch }
}

/** Publica o novo hash na branch atual ou diretamente em HEAD destacado. */
export function updateHead(root, expectedHead, hash) {
  // 1. Revalida HEAD para não atualizar um destino que já mudou durante a operação.
  if (!hashPattern.test(hash)) throw new Error('Invalid commit hash.')

  const current = readHead(root)

  if (
    current.target !== expectedHead.target ||
    current.hash !== expectedHead.hash ||
    current.branch !== expectedHead.branch
  ) {
    throw new Error('HEAD changed while creating the commit.')
  }

  // 2. Grava um temporário exclusivo no mesmo diretório e publica com rename.
  const temporary = join(
    dirname(current.target),
    `ref-tmp-${randomBytes(16).toString('hex')}`,
  )

  let created = false

  try {
    writeFileSync(temporary, `${hash}\n`, { flag: 'wx' })
    created = true
    renameSync(temporary, current.target)
    created = false
  } finally {
    // 3. Remove apenas o temporário criado nesta operação, caso a publicação falhe.
    if (created) unlinkSync(temporary)
  }
}

/** Desconecta HEAD da branch e aponta diretamente para um commit existente. */
export function detachHead(root, expectedHead, hash) {
  // 1. Confere o estado observado antes de alterar o arquivo HEAD.
  if (!hashPattern.test(hash)) throw new Error('Invalid commit hash.')

  const current = readHead(root)

  if (
    current.target !== expectedHead.target ||
    current.hash !== expectedHead.hash ||
    current.branch !== expectedHead.branch
  ) {
    throw new Error('HEAD changed while checking out the commit.')
  }

  // 2. Publica o hash em HEAD, sem alterar a referência da branch anterior.
  const directory = join(root, '.nit')

  const temporary = join(
    directory,
    `head-tmp-${randomBytes(16).toString('hex')}`,
  )

  let created = false

  try {
    writeFileSync(temporary, `${hash}\n`, { flag: 'wx' })
    created = true
    renameSync(temporary, join(directory, 'HEAD'))
    created = false
  } finally {
    // 3. Limpa somente o temporário criado por esta operação.
    if (created) unlinkSync(temporary)
  }
}

/** Conecta HEAD a uma branch sem mover a referência da branch. */
export function attachHead(root, expectedHead, expectedBranch) {
  // 1. Confere novamente tanto HEAD quanto o destino antes da publicação.
  const current = readHead(root)
  if (
    current.target !== expectedHead.target ||
    current.hash !== expectedHead.hash ||
    current.branch !== expectedHead.branch
  ) {
    throw new Error('HEAD changed while checking out the branch.')
  }
  const branch = readBranch(root, expectedBranch.name)
  if (branch.hash !== expectedBranch.hash)
    throw new Error('Branch changed while checking out.')

  // 2. Publica HEAD simbólico por rename sem alterar o arquivo da referência.
  const directory = join(root, '.nit')
  const temporary = join(
    directory,
    `head-tmp-${randomBytes(16).toString('hex')}`,
  )
  let created = false
  try {
    writeFileSync(temporary, `ref: refs/heads/${branch.name}\n`, { flag: 'wx' })
    created = true
    renameSync(temporary, join(directory, 'HEAD'))
    created = false
  } finally {
    // 3. Remove o temporário se não tiver sido publicado.
    if (created) unlinkSync(temporary)
  }
}
