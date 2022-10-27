/******************************************************************************
 * This file was generated by langium-cli 1.0.0.
 * DO NOT EDIT MANUALLY!
 ******************************************************************************/

import { Module } from 'djinject';
import { LangiumGeneratedServices, LangiumGeneratedSharedServices, LangiumSharedServices, LangiumServices, LanguageMetaData } from 'langium';
import { ArithmeticsAstReflection } from './ast';
import { ArithmeticsGrammar } from './grammar';

export const ArithmeticsLanguageMetaData: LanguageMetaData = {
    languageId: 'arithmetics',
    fileExtensions: ['.calc'],
    caseInsensitive: true
};

export const ArithmeticsGeneratedSharedModule: Module<LangiumSharedServices, LangiumGeneratedSharedServices> = {
    AstReflection: () => new ArithmeticsAstReflection()
};

export const ArithmeticsGeneratedModule: Module<LangiumServices, LangiumGeneratedServices> = {
    Grammar: () => ArithmeticsGrammar(),
    LanguageMetaData: () => ArithmeticsLanguageMetaData,
    parser: {}
};
