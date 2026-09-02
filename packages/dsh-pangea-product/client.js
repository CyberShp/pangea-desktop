// PANGEA Desktop product bridge.
// Product navigation and first-launch affordances are rendered by dsh-pangea;
// this package only activates Desktop-owned DSH model integration patches.
window.__ModuleLoader__.load({
  id: 'dsh-pangea-product',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    function apply() {}

    exports.apply = apply
    return module.exports
  },
})
