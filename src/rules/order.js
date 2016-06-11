'use strict'

import find from 'lodash.find'
import importType from '../core/importType'
import isStaticRequire from '../core/staticRequire'

const defaultGroups = ['builtin', 'external', 'parent', 'sibling', 'index']

// REPORTING

function reverse(array) {
  return array.map(function (v) {
    return {
      name: v.name,
      rank: -v.rank,
      node: v.node,
    }
  }).reverse()
}

const re = /^((\.\/)?(\.\.\/)*)(.*)$/
function _pathSort(str1, str2) {
  const res1 = re.exec(str1)
  const res2 = re.exec(str2)
  const path1 = res1[1] || ''
  const path2 = res2[1] || ''
  const name1 = res1[4]
  const name2 = res2[4]
  if (path1.length !== path2.length) return path1.length > path2.length ? 1 : -1
  if (name1 > name2) return 1
  if (name1 < name2) return -1
  return 0
}

function pathSort(str1, str2, reversed) {
  const res = _pathSort(str1, str2)
  return reversed ? res < 0 : res > 0
}

function compare(imp1, imp2, sortPaths, reversed) {
  if (!sortPaths) return false
  if (imp1.rank !== imp2.rank) return false
  let sortDir = sortPaths === 'alphabetical' ? false : true
  if (reversed) sortDir = !sortDir
  return pathSort(imp1.name, imp2.name, sortDir)
}

function findOutOfOrder(imported, sortPaths, reversed) {
  if (imported.length === 0) {
    return []
  }
  let maxSeenRankNode = imported[0]
  return imported.filter(function (importedModule) {
    const res = importedModule.rank < maxSeenRankNode.rank
      || compare(maxSeenRankNode, importedModule, sortPaths, reversed)
    if (maxSeenRankNode.rank < importedModule.rank
      || compare(importedModule, maxSeenRankNode, sortPaths, reversed)) {
      maxSeenRankNode = importedModule
    }
    return res
  })
}

function reportOutOfOrder(context, imported, outOfOrder, order, sortPaths) {
  outOfOrder.forEach(function (imp) {
    const found = find(imported, function hasHigherRank(importedItem) {
      return importedItem.rank > imp.rank
        || compare(importedItem, imp, sortPaths, order === 'after')
    })
    context.report(imp.node, '`' + imp.name + '` import should occur ' + order +
      ' import of `' + found.name + '`')
  })
}

function makeOutOfOrderReport(context, imported, sortPaths) {
  const outOfOrder = findOutOfOrder(imported, sortPaths)
  if (!outOfOrder.length) {
    return
  }
  // There are things to report. Try to minimize the number of reported errors.
  const reversedImported = reverse(imported)
  const reversedOrder = findOutOfOrder(reversedImported, sortPaths, true)
  if (reversedOrder.length < outOfOrder.length) {
    reportOutOfOrder(context, reversedImported, reversedOrder, 'after', sortPaths)
    return
  }
  reportOutOfOrder(context, imported, outOfOrder, 'before', sortPaths)
}

// TODO:: respect the sort-paths flag
function getSortedImported(imported) {
  const sortedImported = [...imported]
  sortedImported.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank > b.rank ? 1 : -1
    return _pathSort(a.name, b.name)
  })
  return sortedImported
}

function report(context, imported, options) {
  const sortPaths = options['sort-paths']
  if (!options.fixable) {
    makeOutOfOrderReport(context, imported, sortPaths)
    if ('newlines-between' in options) {
      makeNewlinesBetweenReport(context, imported, options['newlines-between'])
    }
    return
  }

  const sortedImported = getSortedImported(imported)

  // TODO:: We need to catch cases like this: ././../foo and strip out the leading `./`s
  // TODO:: We also need to catch file extensions and strip them (under a flag)
  // TODO:: We also need to sort named imports
  for (let i = 0; i < imported.length; ++i) {
    const prev = imported[i]
    const nextprev = imported[i + 1]
    const next = sortedImported[i]
    const nextnext = sortedImported[i + 1]
    // TODO:: respect newlines-between flag
    const addTrailingNewLine = shouldAddNewLine(next, nextnext, prev, nextprev, context)
    const needsToMove = prev.name !== next.name
    if (needsToMove || addTrailingNewLine) {
      const msgs = []
      if (needsToMove) msgs.push(`'${next.name}' should be moved to where '${prev.name}' is`)
      if (addTrailingNewLine) msgs.push('a newline should be added')
      context.report({
        node: prev.node,
        message: msgs.join(' and '),
        fix: fixer => {
          if (!needsToMove) return fixer.insertTextAfter(prev.node, '\n')
          const text = addTrailingNewLine ? `${next.text}\n` : next.text
          return fixer.replaceText(prev.node, text)
        },
      })
    }
  }
}

function shouldAddNewLine(next, nextnext, prev, nextprev, context) {
  const getNumberOfEmptyLinesBetween = (currentImport, previousImport) => {
    const linesBetweenImports = context.getSourceCode().lines.slice(
      previousImport.node.loc.end.line,
      currentImport.node.loc.start.line - 1
    )
    return linesBetweenImports.filter((line) => !line.trim().length).length
  }
  const shouldHaveNewLine = nextnext && next.rank !== nextnext.rank
  if (!shouldHaveNewLine) return false
  return getNumberOfEmptyLinesBetween(nextprev, prev) === 0
}

// DETECTING

function computeRank(context, ranks, name, type) {
  return ranks[importType(name, context)] +
    (type === 'import' ? 0 : 100)
}

function registerNode(context, node, name, type, ranks, imported, text) {
  const rank = computeRank(context, ranks, name, type)
  if (rank !== -1) {
    imported.push({name, rank, node, text})
  }
}

function isInVariableDeclarator(node) {
  return node &&
    (node.type === 'VariableDeclarator' || isInVariableDeclarator(node.parent))
}

const types = ['builtin', 'external', 'internal', 'parent', 'sibling', 'index']

// Creates an object with type-rank pairs.
// Example: { index: 0, sibling: 1, parent: 1, external: 1, builtin: 2, internal: 2 }
// Will throw an error if it contains a type that does not exist, or has a duplicate
function convertGroupsToRanks(groups) {
  const rankObject = groups.reduce(function(res, group, index) {
    if (typeof group === 'string') {
      group = [group]
    }
    group.forEach(function(groupItem) {
      if (types.indexOf(groupItem) === -1) {
        throw new Error('Incorrect configuration of the rule: Unknown type `' +
          JSON.stringify(groupItem) + '`')
      }
      if (res[groupItem] !== undefined) {
        throw new Error('Incorrect configuration of the rule: `' + groupItem + '` is duplicated')
      }
      res[groupItem] = index
    })
    return res
  }, {})

  const omittedTypes = types.filter(function(type) {
    return rankObject[type] === undefined
  })

  return omittedTypes.reduce(function(res, type) {
    res[type] = groups.length
    return res
  }, rankObject)
}

function makeNewlinesBetweenReport (context, imported, newlinesBetweenImports) {
  const getNumberOfEmptyLinesBetween = (currentImport, previousImport) => {
    const linesBetweenImports = context.getSourceCode().lines.slice(
      previousImport.node.loc.end.line,
      currentImport.node.loc.start.line - 1
    )

    return linesBetweenImports.filter((line) => !line.trim().length).length
  }
  let previousImport = imported[0]

  imported.slice(1).forEach(function(currentImport) {
    if (newlinesBetweenImports === 'always') {
      if (currentImport.rank !== previousImport.rank
        && getNumberOfEmptyLinesBetween(currentImport, previousImport) === 0)
      {
        context.report(
          previousImport.node, 'There should be at least one empty line between import groups'
        )
      } else if (currentImport.rank === previousImport.rank
        && getNumberOfEmptyLinesBetween(currentImport, previousImport) > 0)
      {
        context.report(
          previousImport.node, 'There should be no empty line within import group'
        )
      }
    } else {
      if (getNumberOfEmptyLinesBetween(currentImport, previousImport) > 0) {
        context.report(previousImport.node, 'There should be no empty line between import groups')
      }
    }

    previousImport = currentImport
  })
}

module.exports = function importOrderRule (context) {
  const options = context.options[0] || {}
  let ranks
  const sourceCode = context.getSourceCode()

  try {
    ranks = convertGroupsToRanks(options.groups || defaultGroups)
  } catch (error) {
    // Malformed configuration
    return {
      Program: function(node) {
        context.report(node, error.message)
      },
    }
  }
  let imported = []
  let level = 0

  function incrementLevel() {
    level++
  }
  function decrementLevel() {
    level--
  }

  return {
    ImportDeclaration: function handleImports(node) {
      if (node.specifiers.length) { // Ignoring unassigned imports
        const name = node.source.value
        const text = sourceCode.getText(node)
        registerNode(context, node, name, 'import', ranks, imported, text)
      }
    },
    CallExpression: function handleRequires(node) {
      if (options.fixable) return
      if (level !== 0 || !isStaticRequire(node) || !isInVariableDeclarator(node.parent)) {
        return
      }
      const name = node.arguments[0].value
      registerNode(context, node, name, 'require', ranks, imported)
    },
    'Program:exit': function reportAndReset() {
      report(context, imported, options)
      imported = []
    },
    FunctionDeclaration: incrementLevel,
    FunctionExpression: incrementLevel,
    ArrowFunctionExpression: incrementLevel,
    BlockStatement: incrementLevel,
    ObjectExpression: incrementLevel,
    'FunctionDeclaration:exit': decrementLevel,
    'FunctionExpression:exit': decrementLevel,
    'ArrowFunctionExpression:exit': decrementLevel,
    'BlockStatement:exit': decrementLevel,
    'ObjectExpression:exit': decrementLevel,
  }
}

module.exports.schema = [
  {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
      },
      'newlines-between': {
        enum: [ 'always', 'never' ],
      },
      'sort-paths': {
        enum: [ 'alphabetical', 'reversedAlphabetical' ],
      },
      fixable: {
        type: 'boolean',
      },
    },
    additionalProperties: false,
  },
]
