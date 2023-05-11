/* eslint-disable jsdoc/no-undefined-types */

/**
 * @typedef {import('estree').Node|
 *   import('@typescript-eslint/types').TSESTree.TSTypeReference} ESTreeOrTypeScriptNode
 */

/**
 * Checks if a node is a promise but has no resolve value or an empty value.
 * An `undefined` resolve does not count.
 *
 * @param {ESTreeOrTypeScriptNode} node
 * @returns {boolean}
 */
const isNewPromiseExpression = (node) => {
  return node && node.type === 'NewExpression' && node.callee.type === 'Identifier' &&
    node.callee.name === 'Promise';
};

/**
 * @param {import('@typescript-eslint/types').TSESTree.TSTypeReference} node
 * @returns {boolean}
 */
const isVoidPromise = (node) => {
  return node?.typeParameters?.params?.[0]?.type === 'TSVoidKeyword';
};

const undefinedKeywords = new Set([
  'TSVoidKeyword', 'TSUndefinedKeyword', 'TSNeverKeyword',
]);

/**
 * Checks if a node has a return statement. Void return does not count.
 *
 * @param {import('estree').Node|import('@typescript-eslint/types').TSESTree.Node} node
 * @param {boolean} throwOnNullReturn
 * @param {PromiseFilter} promFilter
 * @returns {boolean|undefined}
 */
// eslint-disable-next-line complexity
const hasReturnValue = (node, throwOnNullReturn, promFilter) => {
  if (!node) {
    return false;
  }

  switch (node.type) {
  case 'TSDeclareFunction':
  case 'TSFunctionType':
  case 'TSMethodSignature': {
    const type = node?.returnType?.typeAnnotation?.type;
    return type && !undefinedKeywords.has(type);
  }

  case 'MethodDefinition':
    return hasReturnValue(node.value, throwOnNullReturn, promFilter);
  case 'FunctionExpression':
  case 'FunctionDeclaration':
  case 'ArrowFunctionExpression': {
    return 'expression' in node && node.expression && (!isNewPromiseExpression(node.body) || !isVoidPromise(node.body)) ||
      hasReturnValue(node.body, throwOnNullReturn, promFilter);
  }

  case 'BlockStatement': {
    return node.body.some((bodyNode) => {
      return bodyNode.type !== 'FunctionDeclaration' && hasReturnValue(bodyNode, throwOnNullReturn, promFilter);
    });
  }

  case 'LabeledStatement':
  case 'WhileStatement':
  case 'DoWhileStatement':
  case 'ForStatement':
  case 'ForInStatement':
  case 'ForOfStatement':
  case 'WithStatement': {
    return hasReturnValue(node.body, throwOnNullReturn, promFilter);
  }

  case 'IfStatement': {
    return hasReturnValue(node.consequent, throwOnNullReturn, promFilter) ||
      hasReturnValue(node.alternate, throwOnNullReturn, promFilter);
  }

  case 'TryStatement': {
    return hasReturnValue(node.block, throwOnNullReturn, promFilter) ||
      hasReturnValue(node.handler && node.handler.body, throwOnNullReturn, promFilter) ||
      hasReturnValue(node.finalizer, throwOnNullReturn, promFilter);
  }

  case 'SwitchStatement': {
    return node.cases.some(
      (someCase) => {
        return someCase.consequent.some((nde) => {
          return hasReturnValue(nde, throwOnNullReturn, promFilter);
        });
      },
    );
  }

  case 'ReturnStatement': {
    // void return does not count.
    if (node.argument === null) {
      if (throwOnNullReturn) {
        throw new Error('Null return');
      }

      return false;
    }

    if (promFilter && isNewPromiseExpression(node.argument)) {
      // Let caller decide how to filter, but this is, at the least,
      //   a return of sorts and truthy
      return promFilter(node.argument);
    }

    return true;
  }

  default: {
    return false;
  }
  }
};

/**
 * Checks if a node has a return statement. Void return does not count.
 *
 * @param {object} node
 * @param {PromiseFilter} promFilter
 * @returns {boolean|import('estree').Node}
 */
// eslint-disable-next-line complexity
const allBrancheshaveReturnValues = (node, promFilter) => {
  if (!node) {
    return false;
  }

  switch (node.type) {
  case 'TSDeclareFunction':
  case 'TSFunctionType':
  case 'TSMethodSignature': {
    const type = node?.returnType?.typeAnnotation?.type;
    return type && !undefinedKeywords.has(type);
  }

  // case 'MethodDefinition':
  //   return allBrancheshaveReturnValues(node.value, promFilter);
  case 'FunctionExpression':
  case 'FunctionDeclaration':
  case 'ArrowFunctionExpression': {
    return node.expression && (!isNewPromiseExpression(node.body) || !isVoidPromise(node.body)) ||
      allBrancheshaveReturnValues(node.body, promFilter) || node.body.body.some((nde) => {
      return nde.type === 'ReturnStatement';
    });
  }

  case 'BlockStatement': {
    const lastBodyNode = node.body.slice(-1)[0];
    return allBrancheshaveReturnValues(lastBodyNode, promFilter);
  }

  case 'WhileStatement':
  case 'DoWhileStatement':
    if (node.test.value === true) {
      // If this is an infinite loop, we assume only one branch
      //   is needed to provide a return
      return hasReturnValue(node.body, false, promFilter);
    }

    // Fallthrough
  case 'LabeledStatement':
  case 'ForStatement':
  case 'ForInStatement':
  case 'ForOfStatement':
  case 'WithStatement': {
    return allBrancheshaveReturnValues(node.body, promFilter);
  }

  case 'IfStatement': {
    return allBrancheshaveReturnValues(node.consequent, promFilter) && allBrancheshaveReturnValues(node.alternate, promFilter);
  }

  case 'TryStatement': {
    // If `finally` returns, all return
    return node.finalizer && allBrancheshaveReturnValues(node.finalizer, promFilter) ||
      // Return in `try`/`catch` may still occur despite `finally`
      allBrancheshaveReturnValues(node.block, promFilter) &&
        (!node.handler ||
          allBrancheshaveReturnValues(node.handler && node.handler.body, promFilter)) &&
          (!node.finalizer || (() => {
            try {
              hasReturnValue(node.finalizer, true, promFilter);
            } catch (error) {
              // istanbul ignore else
              if (error.message === 'Null return') {
                return false;
              }

              // istanbul ignore next
              throw error;
            }

            // As long as not an explicit empty return, then return true
            return true;
          })());
  }

  case 'SwitchStatement': {
    return node.cases.every(
      (someCase) => {
        return !someCase.consequent.some((consNode) => {
          return consNode.type === 'BreakStatement' ||
            consNode.type === 'ReturnStatement' && consNode.argument === null;
        });
      },
    );
  }

  case 'ThrowStatement': {
    return true;
  }

  case 'ReturnStatement': {
    // void return does not count.
    if (node.argument === null) {
      return false;
    }

    if (promFilter && isNewPromiseExpression(node.argument)) {
      // Let caller decide how to filter, but this is, at the least,
      //   a return of sorts and truthy
      return promFilter(node.argument);
    }

    return true;
  }

  default: {
    return false;
  }
  }
};

/**
 * @callback PromiseFilter
 * @param {object} node
 * @returns {boolean}
 */

/**
 * Avoids further checking child nodes if a nested function shadows the
 * resolver, but otherwise, if name is used (by call or passed in as an
 * argument to another function), will be considered as non-empty.
 *
 * This could check for redeclaration of the resolver, but as such is
 * unlikely, we avoid the performance cost of checking everywhere for
 * (re)declarations or assignments.
 *
 * @param {AST} node
 * @param {string} resolverName
 * @returns {boolean}
 */
// eslint-disable-next-line complexity
const hasNonEmptyResolverCall = (node, resolverName) => {
  if (!node) {
    return false;
  }

  // Arrow function without block
  switch (node.type) {
  // istanbul ignore next -- In Babel?
  case 'OptionalCallExpression':
  case 'CallExpression':
    return node.callee.name === resolverName && (

      // Implicit or explicit undefined
      node.arguments.length > 1 || node.arguments[0] !== undefined
    ) ||
      node.arguments.some((nde) => {
        // Being passed in to another function (which might invoke it)
        return nde.type === 'Identifier' && nde.name === resolverName ||

          // Handle nested items
          hasNonEmptyResolverCall(nde, resolverName);
      });
  case 'ChainExpression':
  case 'Decorator':
  case 'ExpressionStatement':
    return hasNonEmptyResolverCall(node.expression, resolverName);
  case 'ClassBody':
  case 'BlockStatement':
    return node.body.some((bodyNode) => {
      return hasNonEmptyResolverCall(bodyNode, resolverName);
    });
  case 'FunctionExpression':
  case 'FunctionDeclaration':
  case 'ArrowFunctionExpression': {
    // Shadowing
    if (node.params[0]?.name === resolverName) {
      return false;
    }

    return hasNonEmptyResolverCall(node.body, resolverName);
  }

  case 'LabeledStatement':
  case 'WhileStatement':
  case 'DoWhileStatement':
  case 'ForStatement':
  case 'ForInStatement':
  case 'ForOfStatement':
  case 'WithStatement': {
    return hasNonEmptyResolverCall(node.body, resolverName);
  }

  case 'ConditionalExpression':
  case 'IfStatement': {
    return hasNonEmptyResolverCall(node.test, resolverName) ||
      hasNonEmptyResolverCall(node.consequent, resolverName) ||
      hasNonEmptyResolverCall(node.alternate, resolverName);
  }

  case 'TryStatement': {
    return hasNonEmptyResolverCall(node.block, resolverName) ||
      hasNonEmptyResolverCall(node.handler && node.handler.body, resolverName) ||
      hasNonEmptyResolverCall(node.finalizer, resolverName);
  }

  case 'SwitchStatement': {
    return node.cases.some(
      (someCase) => {
        return someCase.consequent.some((nde) => {
          return hasNonEmptyResolverCall(nde, resolverName);
        });
      },
    );
  }

  case 'ArrayPattern':
  case 'ArrayExpression':
    return node.elements.some((element) => {
      return hasNonEmptyResolverCall(element, resolverName);
    });

  case 'AssignmentPattern':
    return hasNonEmptyResolverCall(node.right, resolverName);

  case 'AssignmentExpression':
  case 'BinaryExpression':
  case 'LogicalExpression': {
    return hasNonEmptyResolverCall(node.left, resolverName) ||
      hasNonEmptyResolverCall(node.right, resolverName);
  }

  // Comma
  case 'SequenceExpression':
  case 'TemplateLiteral':
    return node.expressions.some((subExpression) => {
      return hasNonEmptyResolverCall(subExpression, resolverName);
    });

  case 'ObjectPattern':
  case 'ObjectExpression':
    return node.properties.some((property) => {
      return hasNonEmptyResolverCall(property, resolverName);
    });
  // istanbul ignore next -- In Babel?
  case 'ClassMethod':
  case 'MethodDefinition':
    return node.decorators && node.decorators.some((decorator) => {
      return hasNonEmptyResolverCall(decorator, resolverName);
    }) ||
      node.computed && hasNonEmptyResolverCall(node.key, resolverName) ||
      hasNonEmptyResolverCall(node.value, resolverName);

  // istanbul ignore next -- In Babel?
  case 'ObjectProperty':
  /* eslint-disable no-fallthrough */
  // istanbul ignore next -- In Babel?
  case 'PropertyDefinition':
  // istanbul ignore next -- In Babel?
  case 'ClassProperty':
  case 'Property':
  /* eslint-enable no-fallthrough */
    return node.computed && hasNonEmptyResolverCall(node.key, resolverName) ||
      hasNonEmptyResolverCall(node.value, resolverName);
  // istanbul ignore next -- In Babel?
  case 'ObjectMethod':
    // istanbul ignore next -- In Babel?
    return node.computed && hasNonEmptyResolverCall(node.key, resolverName) ||
      node.arguments.some((nde) => {
        return hasNonEmptyResolverCall(nde, resolverName);
      });

  case 'ClassExpression':
  case 'ClassDeclaration':
    return hasNonEmptyResolverCall(node.body, resolverName);

  case 'AwaitExpression':
  case 'SpreadElement':
  case 'UnaryExpression':
  case 'YieldExpression':
    return hasNonEmptyResolverCall(node.argument, resolverName);

  case 'VariableDeclaration': {
    return node.declarations.some((nde) => {
      return hasNonEmptyResolverCall(nde, resolverName);
    });
  }

  case 'VariableDeclarator': {
    return hasNonEmptyResolverCall(node.id, resolverName) ||
      hasNonEmptyResolverCall(node.init, resolverName);
  }

  case 'TaggedTemplateExpression':
    return hasNonEmptyResolverCall(node.quasi, resolverName);

  // ?.
  // istanbul ignore next -- In Babel?
  case 'OptionalMemberExpression':
  case 'MemberExpression':
    return hasNonEmptyResolverCall(node.object, resolverName) ||
      hasNonEmptyResolverCall(node.property, resolverName);

  // istanbul ignore next -- In Babel?
  case 'Import':
  case 'ImportExpression':
    return hasNonEmptyResolverCall(node.source, resolverName);

  case 'ReturnStatement': {
    if (node.argument === null) {
      return false;
    }

    return hasNonEmptyResolverCall(node.argument, resolverName);
  }

  /*
  // Shouldn't need to parse literals/literal components, etc.

  case 'Identifier':
  case 'TemplateElement':
  case 'Super':
  // Exports not relevant in this context
  */
  default:
    return false;
  }
};

/**
 * Checks if a Promise executor has no resolve value or an empty value.
 * An `undefined` resolve does not count.
 *
 * @param {object} node
 * @param {boolean} anyPromiseAsReturn
 * @param {boolean} allBranches
 * @returns {boolean}
 */
const hasValueOrExecutorHasNonEmptyResolveValue = (node, anyPromiseAsReturn, allBranches) => {
  const hasReturnMethod = allBranches ?
    (nde, promiseFilter) => {
      let hasReturn;
      try {
        hasReturn = hasReturnValue(nde, true, promiseFilter);
      } catch (error) {
        // istanbul ignore else
        if (error.message === 'Null return') {
          return false;
        }

        // istanbul ignore next
        throw error;
      }

      // `hasReturn` check needed since `throw` treated as valid return by
      //   `allBrancheshaveReturnValues`
      return hasReturn && allBrancheshaveReturnValues(nde, promiseFilter);
    } :
    (nde, promiseFilter) => {
      return hasReturnValue(nde, false, promiseFilter);
    };

  return hasReturnMethod(node, (prom) => {
    if (anyPromiseAsReturn) {
      return true;
    }

    if (isVoidPromise(prom)) {
      return false;
    }

    const [
      {
        params,
        body,
      } = {},
    ] = prom.arguments;

    if (!params?.length) {
      return false;
    }

    const [
      {
        name: resolverName,
      },
    ] = params;

    return hasNonEmptyResolverCall(body, resolverName);
  });
};

export {
  hasReturnValue,
  hasValueOrExecutorHasNonEmptyResolveValue,
};
