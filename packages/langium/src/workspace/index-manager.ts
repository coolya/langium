/******************************************************************************
 * Copyright 2021 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { URI } from 'vscode-uri';
import type { ServiceRegistry } from '../service-registry';
import type { LangiumSharedServices } from '../services';
import type { AstNode, AstNodeDescription, AstReflection } from '../syntax-tree';
import type { Stream } from '../utils/stream';
import type { ReferenceDescription } from './ast-descriptions';
import type { LangiumDocument, LangiumDocuments } from './documents';
import { CancellationToken } from 'vscode-languageserver';
import { getDocument } from '../utils/ast-util';
import { stream } from '../utils/stream';
import { equalURI } from '../utils/uri-util';
import { DocumentState } from './documents';
import type { ScopeOptions, Scope } from '../references/scope';
import { MapScope } from '../references/scope';

/**
 * The index manager is responsible for keeping metadata about symbols and cross-references
 * in the workspace. It is used to look up symbols in the global scope, mostly during linking
 * and completion. This service is shared between all languages of a language server.
 */
export interface IndexManager {

    /**
     * Deletes the specified document uris from the index.
     * Necessary when documents are deleted and not referenceable anymore.
     *
     * @param uris The document uris to delete.
     */
    remove(uris: URI[]): void;

    /**
     * Updates the information about the exportable content of a document inside the index.
     *
     * @param document Document to be updated
     * @param cancelToken Indicates when to cancel the current operation.
     * @throws `OperationCanceled` if a user action occurs during execution
     */
    updateContent(document: LangiumDocument, cancelToken?: CancellationToken): Promise<void>;

    /**
     * Updates the information about the cross-references of a document inside the index.
     *
     * @param document Document to be updated
     * @param cancelToken Indicates when to cancel the current operation.
     * @throws `OperationCanceled` if a user action occurs during execution
     */
    updateReferences(document: LangiumDocument, cancelToken?: CancellationToken): Promise<void>;

    /**
     * Returns all documents that could be affected by changes in the documents
     * identified by the given URIs.
     *
     * @param uris The document URIs which may affect other documents.
     */
    getAffectedDocuments(uris: URI[]): Stream<LangiumDocument>;

    /**
     * Compute a global scope, optionally filtered using a type identifier.
     *
     * @param nodeType The type to filter with, or `undefined` to return descriptions of all types.
     * @returns a `Scope` targetting all globally visible nodes (of a given type).
     */
    globalScope(nodeType?: string, scopeOptions?: ScopeOptions): Scope;

    /**
     * Returns all known references that are pointing to the given `targetNode`.
     *
     * @param targetNode the `AstNode` to look up references for
     * @param astNodePath the path that points to the `targetNode` inside the document. See also `AstNodeLocator`
     *
     * @returns a `Stream` of references that are targeting the `targetNode`
     */
    findAllReferences(targetNode: AstNode, astNodePath: string): Stream<ReferenceDescription>;

}

export class DefaultIndexManager implements IndexManager {

    protected readonly serviceRegistry: ServiceRegistry;
    protected readonly langiumDocuments: () => LangiumDocuments;
    protected readonly astReflection: AstReflection;

    protected readonly simpleIndex: Map<string, AstNodeDescription[]> = new Map<string, AstNodeDescription[]>();
    protected readonly referenceIndex: Map<string, ReferenceDescription[]> = new Map<string, ReferenceDescription[]>();
    protected readonly globalScopeCache = new Map<string, Scope>();
    protected allElementsCache: AstNodeDescription[] = [];

    constructor(services: LangiumSharedServices) {
        this.serviceRegistry = services.ServiceRegistry;
        this.astReflection = services.AstReflection;
        this.langiumDocuments = () => services.workspace.LangiumDocuments;
    }

    findAllReferences(targetNode: AstNode, astNodePath: string): Stream<ReferenceDescription> {
        const targetDocUri = getDocument(targetNode).uri;
        const result: ReferenceDescription[] = [];
        this.referenceIndex.forEach((docRefs: ReferenceDescription[]) => {
            docRefs.forEach((refDescr) => {
                if (equalURI(refDescr.targetUri, targetDocUri) && refDescr.targetPath === astNodePath) {
                    result.push(refDescr);
                }
            });
        });
        return stream(result);
    }

    globalScope(nodeType = '', scopeOptions?: ScopeOptions): Scope {
        if (this.allElementsCache.length === 0) {
            this.allElementsCache = Array.from(this.simpleIndex.values()).flat();
        }

        const cached = this.globalScopeCache.get(nodeType);
        if (cached) {
            return cached;
        } else {
            const elements = this.allElementsCache.filter(e => this.astReflection.isSubtype(e.type, nodeType));
            const scope = new MapScope(elements, undefined, scopeOptions);
            this.globalScopeCache.set(nodeType, scope);
            return scope;
        }
    }

    remove(uris: URI[]): void {
        for (const uri of uris) {
            const uriString = uri.toString();
            this.simpleIndex.delete(uriString);
            this.referenceIndex.delete(uriString);
            this.globalScopeCache.clear();
            this.allElementsCache = [];
        }
    }

    async updateContent(document: LangiumDocument, cancelToken = CancellationToken.None): Promise<void> {
        this.globalScopeCache.clear();
        this.allElementsCache = [];
        const services = this.serviceRegistry.getServices(document.uri);
        const exports: AstNodeDescription[] = await services.references.ScopeComputation.computeExports(document, cancelToken);
        for (const data of exports) {
            data.node = undefined; // clear reference to the AST Node
        }
        this.simpleIndex.set(document.uri.toString(), exports);
        document.state = DocumentState.IndexedContent;
    }

    async updateReferences(document: LangiumDocument, cancelToken = CancellationToken.None): Promise<void> {
        const services = this.serviceRegistry.getServices(document.uri);
        const indexData: ReferenceDescription[] = await services.workspace.ReferenceDescriptionProvider.createDescriptions(document, cancelToken);
        this.referenceIndex.set(document.uri.toString(), indexData);
        document.state = DocumentState.IndexedReferences;
    }

    getAffectedDocuments(uris: URI[]): Stream<LangiumDocument> {
        return this.langiumDocuments().all.filter(e => {
            if (uris.some(uri => equalURI(e.uri, uri))) {
                return false;
            }
            for (const uri of uris) {
                if (this.isAffected(e, uri)) {
                    return true;
                }
            }
            return false;
        });
    }

    /**
     * Determine whether the given document could be affected by a change of the document
     * identified by the given URI (second parameter).
     */
    protected isAffected(document: LangiumDocument, changed: URI): boolean {
        // Cache the uri string
        const changedUriString = changed.toString();
        const documentUri = document.uri.toString();
        // The document is affected if it contains linking errors
        if (document.references.some(e => e.error !== undefined)) {
            return true;
        }
        const references = this.referenceIndex.get(documentUri);
        // ...or if it contains a reference to the changed file
        if (references) {
            return references.filter(e => !e.local).some(e => equalURI(e.targetUri, changedUriString));
        }
        return false;
    }

}
