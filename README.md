# Code Review Process

This document outlines the complete code review workflow for our project.

## Process Diagram

```mermaid
flowchart TD
    subgraph Developer["👨‍💻 Developer"]
        A[Create PR]
        F1[Fix Issues]
        AF[Address Feedback]
        PU[Push Updates]
        DR[Discuss & Revise]
    end

    subgraph Automation["🤖 Automation"]
        AC[Automated Checks]
    end

    subgraph Review["👀 Reviewers"]
        AR[Assign Reviewers]
        RC[Review Code]
    end

    subgraph Decision["⚙️ Decision Points"]
        D1{Pass?}
        D2{Changes Required?}
        D3{Approved?}
    end

    subgraph Complete["✅ Completion"]
        MG[Merge PR]
        CP([Complete])
    end

    %% Main flow
    A -->|Submit| AC
    AC --> D1
    
    %% Automated check failure path
    D1 -->|No ❌| F1
    F1 -->|Re-submit| AC
    
    %% Automated check pass path
    D1 -->|Yes ✅| AR
    AR -->|Notify| RC
    
    %% Review feedback paths
    RC --> D2
    D2 -->|Yes - Needs Work| AF
    AF --> PU
    PU -->|New Commit| RC
    
    D2 -->|No - Looks Good| D3
    
    %% Approval decision
    D3 -->|No - Major Issues| DR
    DR -->|Refine| PU
    
    D3 -->|Yes - Approved ✅| MG
    MG --> CP

    %% Styling
    style A fill:#a5d8ff,stroke:#4a9eed,stroke-width:2px
    style AC fill:#ffd8a8,stroke:#f59e0b,stroke-width:2px
    style F1 fill:#ffc9c9,stroke:#ef4444,stroke-width:2px
    style AF fill:#ffc9c9,stroke:#ef4444,stroke-width:2px
    style PU fill:#a5d8ff,stroke:#4a9eed,stroke-width:2px
    style AR fill:#d0bfff,stroke:#8b5cf6,stroke-width:2px
    style RC fill:#d0bfff,stroke:#8b5cf6,stroke-width:2px
    style D1 fill:#fff3bf,stroke:#f59e0b,stroke-width:2px
    style D2 fill:#fff3bf,stroke:#f59e0b,stroke-width:2px
    style D3 fill:#fff3bf,stroke:#f59e0b,stroke-width:2px
    style DR fill:#ffd8a8,stroke:#f59e0b,stroke-width:2px
    style MG fill:#b2f2bb,stroke:#22c55e,stroke-width:2px
    style CP fill:#b2f2bb,stroke:#22c55e,stroke-width:2px
```

## Process Steps

### 1. Create Pull Request
Developer creates a PR with a clear description of changes.

### 2. Automated Checks
CI/CD pipeline runs:
- ✅ Linting
- ✅ Unit Tests
- ✅ Integration Tests
- ✅ Build Verification

### 3. Assign Reviewers
Once automated checks pass, reviewers are assigned based on:
- Code ownership
- Expertise area
- Availability

### 4. Code Review
Reviewers examine:
- Code quality & style
- Logic correctness
- Test coverage
- Documentation
- Security concerns

### 5. Feedback Loop
If changes are required:
- Developer addresses feedback
- Pushes new commits
- Re-request review

### 6. Approval & Merge
After approval from all required reviewers:
- PR is merged to target branch
- Branch cleanup (optional)

## Review Checklist

- [ ] Code follows project style guidelines
- [ ] All tests pass
- [ ] New code is properly tested
- [ ] Documentation is updated
- [ ] No security vulnerabilities
- [ ] Performance implications considered
- [ ] Breaking changes documented

## Roles & Responsibilities

| Role | Responsibility |
|------|----------------|
| **Author** | Create quality PR, respond to feedback, keep PR updated |
| **Reviewer** | Thoroughly review code, provide constructive feedback, approve/reject |
| **Automation** | Run CI checks, enforce branch protection rules |

---

> 📝 This diagram is also available as an Excalidraw file: `code-review-process.excalidraw`
