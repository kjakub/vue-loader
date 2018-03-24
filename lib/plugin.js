const qs = require('querystring')
const RuleSet = require('webpack/lib/RuleSet')

// TODO handle vueRule with oneOf
module.exports = class VueLoaderPlugin {
  apply (compiler) {
    // get a hold of the raw rules
    const rawRules = compiler.options.module.rules
    // use webpack's RuleSet utility to normalize user rules
    const rawNormalizedRules = new RuleSet(rawRules).rules

    // find the rule that applies to vue files
    const vueRuleIndex = rawRules.findIndex((rule, i) => {
      // #1201 we need to skip the `include` check when locating the vue rule
      const clone = Object.assign({}, rule)
      delete clone.include
      const normalized = RuleSet.normalizeRule(clone, {}, '')
      return !rule.enforce && normalized.resource && normalized.resource(`foo.vue`)
    })
    const vueRule = rawRules[vueRuleIndex]

    if (!vueRule) {
      throw new Error(
        `[VueLoaderPlugin Error] No matching rule for .vue files found.\n` +
        `Make sure there is at least one root-level rule that matches .vue files.`
      )
    }

    if (vueRule.oneOf) {
      throw new Error(
        `[VueLoaderPlugin Error] vue-loader 15 currently does not support vue rules with oneOf.`
      )
    }

    // find the normalized version of the vue rule
    const normalizedVueRule = rawNormalizedRules[vueRuleIndex]
    // get the normlized "use" for vue files
    const normalizedVueUse = normalizedVueRule.use
    // get vue-loader options
    const vueLoaderUseIndex = normalizedVueUse.findIndex(u => {
      return /^vue-loader|(\/|\\)vue-loader/.test(u.loader)
    })

    if (vueLoaderUseIndex < 0) {
      throw new Error(
        `[VueLoaderPlugin Error] No matching use for vue-loader is found.\n` +
        `Make sure the rule matching .vue files include vue-loader in its use.`
      )
    }

    // make sure vue-loader options has a known ident so that we can share
    // options by reference in the template-loader by using a ref query like
    // template-loader??vue-loader-options
    const ident = 'vue-loader-options'
    const vueLoaderUse = normalizedVueUse[vueLoaderUseIndex]
    // has options, just set ident
    if (vueLoaderUse.options) {
      vueLoaderUse.options.ident = ident
    } else {
      // user provided no options, but we must ensure the options is present
      // otherwise RuleSet throws error if no option for a given ref is found.
      if (vueRule.loader || vueRule.loaders) {
        vueRule.options = { ident }
      } else if (vueRule.use) {
        const use = vueRule.use[vueLoaderUseIndex]
        if (typeof use === 'string') {
          vueRule.use[vueLoaderUseIndex] = { loader: use, options: { ident }}
        } else {
          use.options = { ident }
        }
      } else {
        throw new Error(
          `VueLoaderPlugin Error: this should not happen. Please open an issue ` +
          `with your webpack config.`
        )
      }
    }

    // get new rules without the vue rule
    const baseRules = rawRules.filter(r => r !== vueRule)
    const normalizedRules = rawNormalizedRules.filter(r => r !== normalizedVueRule)

    // for each user rule, inject a cloned rule by checking if the rule
    // matches the lang specified in the resourceQuery.
    rawRules.unshift.apply(rawRules, baseRules.map((rule, i) => {
      return cloneRule(rule, normalizedRules[i])
    }))

    // inject global pitcher (responsible for injecting template compiler
    // loader & CSS post loader)
    rawRules.unshift({
      loader: require.resolve('./loaders/pitch')
    })
  }
}

function cloneRule (rule, normalizedRule) {
  // Assuming `test` and `resourceQuery` tests are executed in series and
  // synchronously (which is true based on RuleSet's implementation), we can
  // save the current resource being matched from `test` so that we can access
  // it in `resourceQuery`. This ensures when we use the normalized rule's
  // resource check, include/exclude are matched correctly.
  let currentResource
  const res = Object.assign({}, rule, {
    test: resource => {
      currentResource = resource
      return /\.vue$/.test(resource)
    },
    resourceQuery: query => {
      const parsed = qs.parse(query.slice(1))
      const { resource, resourceQuery } = normalizedRule
      if (resource && parsed.lang == null) {
        return false
      }
      const fakeResourcePath = `${currentResource.replace(/\.vue$/, '')}.${parsed.lang}`
      if (resource && !resource(fakeResourcePath)) {
        return false
      }
      if (resourceQuery && !resourceQuery(query)) {
        return false
      }
      return true
    },
    use: normalizedRule.use ? normalizedRule.use.map(reuseIdent) : undefined
  })

  // delete shorthand since we have normalized use
  delete res.loader
  delete res.loaders
  delete res.options

  if (rule.oneOf) {
    res.oneOf = rule.oneOf.map((r, i) => {
      return cloneRule(r, normalizedRule.oneOf[i])
    })
  }

  return res
}

// Some loaders like babel-loader passes its own option directly to babel
// and since babel validates the options, "ident" would cause an unknown option
// error. For these loaders we'll bail out on the ident reuse.
const reuseIdentBlackList = /babel-loader/

// Reuse options ident, so that imports from within css-loader would get the
// exact same request prefixes, avoiding duplicated modules (#1199)
function reuseIdent (use) {
  if (use.ident && !reuseIdentBlackList.test(use.loader)) {
    use.options.ident = use.ident
    delete use.ident
  }
  return use
}