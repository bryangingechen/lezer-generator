import {Term, TermSet, Rule, PREC_REPEAT, cmpSet, Conflicts, union} from "./grammar"
import {hash, hashString} from "./hash"

export class Pos {
  hash: number

  constructor(readonly rule: Rule,
              readonly pos: number,
              readonly ahead: readonly Term[],
              readonly ambigAhead: readonly string[],
              readonly prev: Pos | null) {
    let h = hash(rule.id, pos)
    for (let a of this.ahead) h = hash(h, a.hash)
    for (let group of ambigAhead) h = hashString(h, group)
    this.hash = h
  }

  get next() {
    return this.pos < this.rule.parts.length ? this.rule.parts[this.pos] : null
  }

  advance() {
    return new Pos(this.rule, this.pos + 1, this.ahead, this.ambigAhead, this)
  }

  reverse() {
    return new Pos(this.rule, this.pos - 1, this.ahead, this.ambigAhead, this.prev!.prev)
  }

  cmp(pos: Pos) {
    return this.rule.cmp(pos.rule) || this.pos - pos.pos ||
      cmpSet(this.ahead, pos.ahead, (a, b) => a.cmp(b)) || cmpSet(this.ambigAhead, pos.ambigAhead, cmpStr)
  }

  eqSimple(pos: Pos) {
    return pos.rule == this.rule && pos.pos == this.pos
  }

  toString() {
    let parts = this.rule.parts.map(t => t.name)
    parts.splice(this.pos, 0, "·")
    return `${this.rule.name} -> ${parts.join(" ")}`
  }

  eq(other: Pos) {
    return this == other ||
      this.hash == other.hash && this.rule == other.rule && this.pos == other.pos &&
      sameSet(this.ahead, other.ahead) &&
      sameSet(this.ambigAhead, other.ambigAhead)
  }

  trail() {
    let result = []
    for (let cur = this.prev; cur; cur = cur.prev) result.push(cur.next)
    return result.reverse().join(" ")
  }

  conflicts(pos = this.pos) {
    let result = this.rule.conflicts[pos]
    if (pos == this.rule.parts.length && this.ambigAhead.length) result = result.join(new Conflicts(0, this.ambigAhead))
    return result
  }

  static conflictsAt(group: readonly Pos[], context: readonly Pos[]) {
    let result = Conflicts.none
    let scan: Term[] = []
    for (let pos of group) {
      result = result.join(pos.conflicts())
      if (pos.pos == 0) addTo(pos.rule.name, scan)
    }
    for (let i = 0; i < scan.length; i++) {
      let name = scan[i]
      for (let pos of context) if (pos.next == name) {
        result = result.join(pos.conflicts())
        if (pos.pos == 0) addTo(pos.rule.name, scan)
      }
    }
    return result
  }
}

function cmpStr(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function termsAhead(rule: Rule, pos: number, after: readonly Term[], first: {[name: string]: Term[]}): Term[] {
  let found: Term[] = []
  for (let i = pos + 1; i < rule.parts.length; i++) {
    let next = rule.parts[i], cont = false
    if (next.terminal) {
      addTo(next, found)
    } else for (let term of first[next.name]) {
      if (term == null) cont = true
      else addTo(term, found)
    }
    if (!cont) return found
  }
  for (let a of after) addTo(a, found)
  return found
}

function eqSet<T extends {eq(other: T): boolean}>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}

function sameSet<T>(a: readonly T[], b: readonly T[]) {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false
  return true
}

export class Shift {
  constructor(readonly term: Term, readonly target: State) {}

  eq(other: Shift | Reduce): boolean { return other instanceof Shift && other.target == this.target }

  toString() { return "s" + this.target.id }

  map(mapping: number[], states: State[]) { return new Shift(this.term, states[mapping[this.target.id]]) }
}

export class Reduce {
  constructor(readonly term: Term, readonly rule: Rule) {}

  eq(other: Shift | Reduce): boolean { return other instanceof Reduce && other.rule == this.rule }

  toString() { return `${this.rule.name.name}(${this.rule.parts.length})` }

  map() { return this }
}

const ACCEPTING = 1 /*FIXME unused*/, AMBIGUOUS = 2 // FIXME maybe store per terminal

function hashPositions(set: readonly Pos[]) {
  let h = 5381
  for (let pos of set) h = hash(h, pos.hash)
  return h
}

export class State {
  actions: (Shift | Reduce)[] = []
  actionPositions: (readonly Pos[])[] = []
  goto: Shift[] = []
  recover: Shift[] = []
  _tokenGroups = -1

  constructor(readonly id: number, readonly set: readonly Pos[], public flags = 0, public hash = hashPositions(set)) {}

  get ambiguous() { return (this.flags & AMBIGUOUS) > 0 }
  get accepting() { return (this.flags & ACCEPTING) > 0 }

  toString() {
    let actions = this.actions.map(t => t.term + "=" + t).join(",") +
      (this.goto.length ? " | " + this.goto.map(g => g.term + "=" + g).join(",") : "")
    return this.id + ": " + this.set.filter(p => p.pos > 0).join() + (actions.length ? "\n  " + actions : "")
  }

  addActionInner(value: Shift | Reduce, positions: readonly Pos[]): Shift | Reduce | null {
    check: for (let i = 0; i < this.actions.length; i++) {
      let action = this.actions[i]
      if (action.term == value.term) {
        if (action.eq(value)) return null
        let conflicts = Pos.conflictsAt(positions, this.set)
        if (conflicts.precedence != PREC_REPEAT) this.flags |= AMBIGUOUS
        let actionConflicts = Pos.conflictsAt(this.actionPositions[i], this.set)
        let diff = conflicts.precedence - actionConflicts.precedence
        if (diff > 0) { // Drop the existing action
          this.actions.splice(i, 1)
          this.actionPositions.splice(i, 1)
          i--
          continue check
        } else if (diff < 0) { // Drop this one
          return null
        } else if (conflicts.ambigGroups.some(g => actionConflicts.ambigGroups.includes(g))) { // Explicitly allowed ambiguity
          continue check
        } else { // Not resolved
          return action
        }
      }
    }
    this.actions.push(value)
    this.actionPositions.push(positions)
    return null
  }

  addAction(value: Shift | Reduce, positions: readonly Pos[]) {
    let conflict = this.addActionInner(value, positions)
    if (conflict) {
      let conflictPos = this.actionPositions[this.actions.indexOf(conflict)][0]
      let error
      if (conflict instanceof Shift)
        error = `shift/reduce conflict between\n  ${conflictPos}\nand\n  ${positions[0].rule}`
      else
        error = `reduce/reduce conflict between\n  ${positions[0].rule}\nand\n  ${conflictPos.rule}`
      let trail = positions[0].trail()
      if (trail.length > 50) trail = trail.slice(trail.length - 50).replace(/.*? /, "… ")
      error += `\nWith input:\n  ${trail} · ${value.term} …`
      throw new Error(error)
    }
  }

  getGoto(term: Term) {
    return this.goto.find(a => a.term == term)
  }

  hasSet(set: readonly Pos[]) {
    return eqSet(this.set, set)
  }

  get tokenGroups() {
    if (this._tokenGroups == -1) {
      let groups = 0
      for (let action of this.actions) if (action.term.groupID > -1) groups |= 1 << action.term.groupID
      this._tokenGroups = groups || 1
    }
    return this._tokenGroups
  }
}

class AddedPos {
  constructor(readonly rule: Rule,
              readonly ahead: Term[],
              readonly origIndex: number,
              public ambigAhead: readonly string[],
              readonly prev: Pos | null) {}
}

function closure(set: readonly Pos[], first: {[name: string]: Term[]}) {
  let added: AddedPos[] = [], redo: AddedPos[] = []
  function addFor(name: Term, ahead: readonly Term[], ambigAhead: readonly string[], prev: Pos | null) {
    for (let rule of name.rules) {
      let add = added.find(a => a.rule == rule)
      if (!add) {
        let existing = set.findIndex(p => p.pos == 0 && p.rule == rule)
        add = new AddedPos(rule, existing < 0 ? [] : set[existing].ahead.slice(), existing, ambigAhead, prev)
        added.push(add)
      } else {
        add.ambigAhead = union(add.ambigAhead, ambigAhead)
      }
      for (let term of ahead) if (!add.ahead.includes(term)) {
        add.ahead.push(term)
        if (add.rule.parts.length && !add.rule.parts[0].terminal) addTo(add, redo)
      }
    }
  }
  
  for (let pos of set) {
    let next = pos.next
    if (next && !next.terminal)
      addFor(next, termsAhead(pos.rule, pos.pos, pos.ahead, first),
             pos.conflicts(pos.pos + 1).ambigGroups, pos.prev)
  }
  while (redo.length) {
    let add = redo.pop()!
    addFor(add.rule.parts[0], termsAhead(add.rule, 0, add.ahead, first),
           union(add.rule.conflicts[1].ambigGroups, add.rule.parts.length == 1 ? add.ambigAhead : none),
           add.prev)
  }

  let result = set.slice()
  for (let add of added) {
    let pos = new Pos(add.rule, 0, add.ahead.sort((a, b) => a.hash - b.hash), add.ambigAhead, add.prev)
    if (add.origIndex > -1) result[add.origIndex] = pos
    else result.push(pos)
  }
  return result.sort((a, b) => a.cmp(b))
}

function addTo<T>(value: T, array: T[]) {
  if (!array.includes(value)) array.push(value)
}

function computeFirst(terms: TermSet) {
  let table: {[term: string]: Term[]} = {}
  for (let t of terms.nonTerminals) table[t.name] = []
  for (;;) {
    let change = false
    for (let nt of terms.nonTerminals) for (let rule of nt.rules) {
      let set = table[nt.name]
      let found = false, startLen = set.length
      for (let part of rule.parts) {
        found = true
        if (part.terminal) {
          addTo(part, set)
        } else {
          for (let t of table[part.name]) {
            if (t == null) found = false
            else addTo(t, set)
          }
        }
        if (found) break
      }
      if (!found) addTo(null, set)
      if (set.length > startLen) change = true
    }
    if (!change) return table
  }
}

class Core {
  constructor(readonly set: readonly Pos[], readonly state: State) {}
}

// Builds a full LR(1) automaton
export function buildFullAutomaton(terms: TermSet, first: {[name: string]: Term[]}) {
  let states: State[] = []
  let cores: {[hash: number]: Core[]} = {}
  function getState(core: readonly Pos[]) {
    if (core.length == 0) return null
    let coreHash = hashPositions(core), byHash = cores[coreHash]
    if (byHash) for (let known of byHash) if (eqSet(core, known.set))
      return known.state

    let set = closure(core, first)
    let hash = hashPositions(set), found
    for (let state of states) if (state.hash == hash && state.hasSet(set)) found = state
    if (!found) {
      found = new State(states.length, set, 0, hash)
      states.push(found)
    }
    ;(cores[coreHash] || (cores[coreHash] = [])).push(new Core(core, found))
    return found
  }
  getState(terms.nonTerminals.find(nt => nt.name == "program")!.rules
           .map(rule => new Pos(rule, 0, [terms.eof], none, null)))

  for (let filled = 0; filled < states.length; filled++) {
    let state = states[filled]
    let byTerm: Term[] = [], byTermPos: Pos[][] = [], atEnd: Pos[] = []
    for (let pos of state.set) {
      if (pos.pos == pos.rule.parts.length) {
        atEnd.push(pos)
      } else {
        let next = pos.rule.parts[pos.pos]
        let index = byTerm.indexOf(next)
        if (index < 0) {
          byTerm.push(next)
          byTermPos.push([pos.advance()])
        } else {
          byTermPos[index].push(pos.advance())
        }
      }
    }
    for (let i = 0; i < byTerm.length; i++) {
      let term = byTerm[i]
      if (term.terminal) {
        let set = applyCut(byTermPos[i])
        let next = getState(set)
        if (next) state.addAction(new Shift(term, next), set.map(p => p.reverse()))
      } else {
        let goto = getState(byTermPos[i])
        if (goto) state.goto.push(new Shift(term, goto))
      }
    }
    let program = state.set.findIndex(pos => pos.pos == 0 && pos.rule.name.program)
    if (program > -1) {
      let accepting = new State(states.length, none, ACCEPTING)
      states.push(accepting)
      state.goto.push(new Shift(state.set[program].rule.name, accepting))
    }
    for (let pos of atEnd) for (let ahead of pos.ahead)
      state.addAction(new Reduce(ahead, pos.rule), [pos])
  }

  return states
}

function applyCut(set: readonly Pos[]): readonly Pos[] {
  let found: null | Pos[] = null, cut = 1
  for (let pos of set) {
    let value = pos.rule.conflicts[pos.pos - 1].cut
    if (value < cut) continue
    if (!found || value > cut) {
      cut = value
      found = []
    }
    found.push(pos)
  }
  return found || set
}

function mergeState(mapping: number[], newStates: State[], state: State, target: State): boolean {
  for (let j = 0; j < state.actions.length; j++)
    if (target.addActionInner(state.actions[j].map(mapping, newStates), state.actionPositions[j]))
      return false
  for (let goto of state.goto) {
    if (!target.goto.find(a => a.term == goto.term))
      target.goto.push(goto.map(mapping, newStates))
  }
  return true
}

function markConflicts(mapping: number[], newID: number, oldStates: State[], newStates: State[], conflicts: number[]) {
  // For all combinations of merged states
  for (let i = 0; i < mapping.length; i++) if (mapping[i] == newID) {
    for (let j = 0; j < mapping.length; j++) if (j != i && mapping[j] == newID) {
      // Create a dummy state to determine whether there's a conflict
      let state = new State(0, none)
      mergeState(mapping, newStates, oldStates[i], state)
      if (!mergeState(mapping, newStates, oldStates[j], state)) conflicts.push(i, j)
    }
  }
}

function hasConflict(id: number, newID: number, mapping: number[], conflicts: number[]) {
  for (let i = 0; i < conflicts.length; i++) if (conflicts[i] == id) {
    let other = conflicts[i + (i % 2 ? -1 : 1)] // Pick other side of the pair
    if (mapping[other] == newID) return true
  }
  return false
}

// Collapse an LR(1) automaton to an LALR-like automaton
function collapseAutomaton(states: State[]): State[] {
  let conflicts: number[] = []
  for (;;) {
    let newStates: State[] = [], mapping: number[] = []
    for (let i = 0; i < states.length; i++) {
      let state = states[i], set = state.set
      let newID = newStates.findIndex((s, index) => {
        return s.set.length == set.length && s.set.every((p, i) => p.eqSimple(set[i])) &&
          s.tokenGroups == state.tokenGroups &&
          !hasConflict(i, index, mapping, conflicts)
      })
      if (newID < 0) {
        newID = newStates.length
        let newState = new State(newID, set, state.flags, 0)
        newState._tokenGroups = state.tokenGroups
        newStates.push(newState)
      } else {
        newStates[newID].flags |= state.flags
      }
      mapping.push(newID)
    }
    let conflicting: number[] = []
    for (let i = 0; i < states.length; i++) {
      let newID = mapping[i]
      if (conflicting.includes(newID)) continue // Don't do work for states that are known to conflict
      if (!mergeState(mapping, newStates, states[i], newStates[mapping[i]])) {
        conflicting.push(newID)
        markConflicts(mapping, newID, states, newStates, conflicts)
      }
    }
    if (!conflicting.length) return newStates
  }
}

const none: readonly any[] = []

function addRecoveryRules(table: State[], first: {[name: string]: Term[]}) {
  for (let state of table) {
    for (let pos of state.set) if (pos.pos > 0) {
      for (let i = pos.pos + 1; i < pos.rule.parts.length; i++) {
        let part = pos.rule.parts[i]
        terms: for (let term of (part.terminal ? [part] : first[part.name])) if (term && !state.recover.some(a => a.term == term)) {
          let next = pos.rule.parts[pos.pos]
          let action = next.terminal ? state.actions.find(t => t.term == next) : state.getGoto(next)
          if (!action || !(action instanceof Shift)) continue
          state.recover.push(new Shift(term, action.target))
        }
      }
    }
  }
}

export function buildAutomaton(terms: TermSet) {
  let first = computeFirst(terms)
  let full = buildFullAutomaton(terms, first)
  let table = collapseAutomaton(full)
  addRecoveryRules(table, first)
  return table
}
