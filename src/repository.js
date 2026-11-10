/**
 * CONTEXTO: REPOSITÓRIO E ÁRVORE DE TRABALHO
 *
 * O diretório de trabalho contém os arquivos editados pela pessoa usuária.
 * Dentro dele, .nit/ guarda os dados internos do NIT, como a object store,
 * referências e HEAD. Separar essas áreas permite que os comandos localizem
 * os metadados sem confundi-los com arquivos que a pessoa deseja versionar.
 *
 * Um comando pode começar em um subdiretório, então procuramos .nit subindo
 * pelos diretórios pais até encontrar a raiz do repositório. Ao preparar um
 * arquivo para armazenamento, limitamos os caminhos à árvore de trabalho e
 * rejeitamos .nit e links simbólicos, que poderiam apontar para fora dela.
 *
 * HEAD começa apontando para refs/heads/main. A ref ainda não existe: ela só
 * poderá apontar para um commit quando houver um. Reinicializar um repositório
 * existente não deve substituir seus metadados nem apagar seu histórico.
 */

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Verifica se o caminho existe e é um diretório real, sem seguir links.
 * Retorna false para um caminho ausente e gera erro para um tipo inválido.
 */
function checkNitDirectory(path) {
  try {
    // Usa lstat para inspecionar o próprio caminho, sem seguir um link simbólico.
    const info = lstatSync(path)

    if (!info.isDirectory()) {
      throw new Error(`"${path}" exists but is not a valid .nit directory.`)
    }

    return true
  } catch (error) {
    // Ausência é esperada durante a busca; outros erros precisam ser propagados.
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Procura .nit no diretório inicial e depois em cada diretório pai.
 * Assim, um comando executado em um subdiretório encontra a raiz do projeto.
 * Se a busca chegar à raiz do sistema sem sucesso, informa que não há repositório.
 */
export function findRepository(start = process.cwd()) {
  // 1. Converte o ponto de partida para um caminho absoluto.
  let current = resolve(start)

  while (true) {
    // 2. Procura .nit no diretório atual e retorna a raiz quando encontrá-lo.
    if (checkNitDirectory(join(current, '.nit'))) return current

    const parent = dirname(current)

    // 3. Na raiz do sistema não há mais pais para examinar.
    if (parent === current) {
      throw new Error('Not a NIT repository (no .nit directory found).')
    }

    // 4. Repete a busca no diretório pai.
    current = parent
  }
}

/**
 * Resolve um arquivo da árvore de trabalho antes de armazenar seu conteúdo:
 * 1. interpreta a entrada em relação ao diretório atual;
 * 2. rejeita caminhos fora da raiz ou dentro dos metadados .nit;
 * 3. examina cada componente sem seguir links e exige um arquivo comum no fim.
 * Para preparar uma remoção, allowMissing permite que componentes não existam.
 *
 * Essa checagem e a leitura posterior são operações separadas: ela não protege
 * completamente contra alterações maliciosas concorrentes no sistema de arquivos.
 */
export function resolveWorktreeFile(
  root,
  input,
  directory = process.cwd(),
  { allowMissing = false } = {},
) {
  // 1. Resolve a entrada e calcula seu caminho relativo à raiz do repositório.
  const path = resolve(directory, input)
  const local = relative(root, path)

  // 2. Rejeita a própria raiz e caminhos que escapem da árvore de trabalho.
  if (
    !local ||
    local === '..' ||
    local.startsWith(`..${sep}`) ||
    isAbsolute(local)
  ) {
    throw new Error('File must be inside the repository working tree.')
  }

  // 3. Impede que metadados internos sejam tratados como arquivos do projeto.
  const parts = local.split(sep)

  if (parts[0] === '.nit') {
    throw new Error('Cannot read files inside .nit.')
  }

  // 4. Inspeciona cada componente com lstat para não seguir links simbólicos.
  let current = root

  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let info
    try {
      info = lstatSync(current)
    } catch (error) {
      // Se o caminho foi removido, os componentes restantes também não existem.
      if (allowMissing && error.code === 'ENOENT') return path
      throw error
    }

    if (info.isSymbolicLink())
      throw new Error('Symbolic links are not supported.')

    // O último componente deve ser arquivo comum; os anteriores, diretórios.
    if (index === parts.length - 1 && !info.isFile())
      throw new Error('Expected a regular file.')

    if (index < parts.length - 1 && !info.isDirectory())
      throw new Error('Expected a directory.')
  }

  return path
}

/**
 * Inicializa o repositório no diretório informado:
 * 1. preserva uma estrutura existente ou informa se ela estiver incompleta;
 * 2. cria .nit, objects e refs/heads em um repositório novo;
 * 3. faz HEAD apontar para main, sem criar a ref antes do primeiro commit.
 *
 * Retorna a raiz e uma indicação de que o repositório já existia.
 */
export function initRepository(directory = process.cwd()) {
  // 1. Identifica a raiz e o local reservado aos metadados.
  const root = resolve(directory)
  const nit = join(root, '.nit')

  // Uma reinicialização nunca recria nem modifica os metadados existentes.
  // Se estiverem incompletos, pedimos intervenção em vez de adivinhar o estado.
  if (checkNitDirectory(nit)) {
    for (const path of ['objects', 'refs', 'refs/heads']) {
      if (!checkNitDirectory(join(nit, path))) {
        throw new Error(`Incomplete NIT repository: missing ${path}.`)
      }
    }

    // Confere também a presença de HEAD antes de considerar a estrutura válida.
    try {
      readFileSync(join(nit, 'HEAD'))
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new Error('Incomplete NIT repository: missing HEAD.')

      throw error
    }

    return { root, existing: true }
  }

  // 2. Cria a estrutura; a criação exclusiva de .nit não sobrescreve outro diretório.
  mkdirSync(nit)
  mkdirSync(join(nit, 'objects'))
  mkdirSync(join(nit, 'refs', 'heads'), { recursive: true })

  // 3. HEAD aponta para a branch, mas a ref ainda não existe: não há commits.
  writeFileSync(join(nit, 'HEAD'), 'ref: refs/heads/main\n', { flag: 'wx' })
  return { root, existing: false }
}
