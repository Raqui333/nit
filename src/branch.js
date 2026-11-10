/**
 * CONTEXTO: BRANCHES
 *
 * Uma branch é um nome que aponta para um commit, não uma cópia de arquivos.
 * Criá-la registra o hash atual sem alterar HEAD nem a árvore de trabalho.
 * Commits feitos depois em uma branch atualizam apenas a referência conectada a
 * HEAD; em HEAD destacado, a nova branch pode apontar para o commit destacado.
 *
 * Nesta versão não criamos branches antes do primeiro commit e não criamos uma
 * ref para a main inicial vazia. Nomes semelhantes a hashes completos são
 * reservados para evitar ambiguidade com checkout de commit.
 */

import { readCommit } from './commit-store.js'
import { createBranchReference, readHead } from './ref-store.js'

/** Cria uma branch no commit atual sem mudar HEAD. */
export function createBranch(root, name) {
  // 1. Exige que HEAD aponte para um commit existente, inclusive se destacado.
  const head = readHead(root)

  if (!head.hash)
    throw new Error('Cannot create a branch before the first commit.')

  readCommit(root, head.hash)

  // 2. Publica a nova referência exclusivamente, preservando a branch atual.
  createBranchReference(root, name, head.hash)
  return { name, hash: head.hash }
}
