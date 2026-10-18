# Keep track of model changes

A tonto workspace works without Git. For ongoing modeling, a local Git
repository makes changes to `.tonto` files easy to review and recover. You do
not need a remote repository or a hosting account.

Open **Source Control**. If the folder is already in a repository, review its
changes there. Otherwise, select **Initialize Repository** if you want to
start tracking this workspace. Save a commit when the model reaches a state
you want to keep, especially before a substantial refactoring.

Git tracks files; it does not determine which tonto files belong to an
ontology. Ontology headers and package declarations do that.
